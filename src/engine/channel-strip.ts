import { CHANNEL_PAN_SPEC, CHANNEL_PITCH_SPEC, CHANNEL_VOLUME_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import { automatedOwners, ownerKey } from '@core/automation/owners';
import type { AudioClip, AudioClipChannel, InsertId, InstrumentChannel, Project } from '@core/model/types';
import { clipSampleId, playbackMode, stretchScale } from '@core/audio/playback';
import type { TempoMap } from '@core/time/ppq';
import type { InstrumentInstance, JsonValue, NoteOff, NoteOn, ParamSignal } from '@agstudio/sdk';
import { HostImpl } from './host';
import { createClipPlayer, type ClipPlayer } from './clip-player';
import type { EngineCore } from './engine-core';
import { AutoLane } from './param-lane';
import type { AudioOn } from './sched/transport';

/** Time constant of channel volume/pan/pitch moves. */
const TAU = 0.004;

/**
 * The channel's pitch in cents: its pitch knob (and automation) plus live pitch bend, summed into
 * one node instruments connect to their voices' detune.
 */
class PitchSignal implements ParamSignal {
  readonly node: GainNode;
  readonly lane: AutoLane;
  private readonly knob: ConstantSourceNode;
  private readonly bend: ConstantSourceNode;
  private bendCents = 0;

  constructor(ctx: BaseAudioContext, key: string, cents: number) {
    this.node = new GainNode(ctx);
    this.knob = new ConstantSourceNode(ctx, { offset: 0 });
    this.bend = new ConstantSourceNode(ctx, { offset: 0 });
    this.lane = new AutoLane(ctx, key, CHANNEL_PITCH_SPEC, cents, TAU);
    this.lane.bind(this.knob.offset);
    this.knob.connect(this.node);
    this.bend.connect(this.node);
    this.knob.start();
    this.bend.start();
  }

  connect(target: AudioParam): () => void {
    this.node.connect(target);
    return () => {
      try {
        this.node.disconnect(target);
      } catch {
        /* already disconnected */
      }
    };
  }

  /** Live pitch bend in cents (MIDI input). */
  setBend(cents: number, time: number): void {
    this.bendCents = cents;
    this.bend.offset.setTargetAtTime(cents, time, 0.002);
  }

  pitchAt(time: number): number {
    return this.lane.valueAt(time) + this.bendCents;
  }

  dispose(): void {
    for (const n of [this.knob, this.bend]) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
      n.disconnect();
    }
    this.lane.dispose();
    this.node.disconnect();
  }
}

/**
 * A channel in the channel rack: instrument → volume → pan → mute → its mixer insert.
 * Plugin creation is async; until it resolves, notes are dropped.
 */
export class ChannelStrip {
  readonly input: GainNode;
  private readonly vol: GainNode;
  private readonly panner: StereoPannerNode;
  readonly out: GainNode;
  private readonly volLane: AutoLane;
  private readonly panLane: AutoLane;
  /** Instrument channels only. */
  private readonly pitch: PitchSignal | null;
  private readonly unregister: (() => void)[] = [];
  private instance: InstrumentInstance | null = null;
  private host: HostImpl | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private muted = false;
  /** Seconds the song's events for this channel are scheduled later (delay compensation, see setShift). */
  private shiftSec = 0;
  /** The plugin's host from the moment it is made (`host` only once the plugin exists). */
  private liveHost: HostImpl | null = null;
  private channel: InstrumentChannel | AudioClipChannel;
  private project: Project;
  /** Audio-clip channels: the clip player (also `instance`). Its buffers come from the engine's residency. */
  private clipPlayer: ClipPlayer | null = null;
  /** True when the plugin is missing or failed to load (silent placeholder; data is kept). */
  faulted = false;

  constructor(
    private readonly core: EngineCore,
    channel: InstrumentChannel | AudioClipChannel,
    project: Project,
  ) {
    const ctx = core.ctx;
    this.channel = channel;
    this.project = project;
    this.input = new GainNode(ctx);
    this.vol = new GainNode(ctx);
    this.panner = new StereoPannerNode(ctx);
    this.out = new GainNode(ctx);
    const key = (param: 'volume' | 'pan' | 'pitch') => targetKey({ kind: 'channel', channelId: channel.id, param });
    this.volLane = new AutoLane(ctx, key('volume'), CHANNEL_VOLUME_SPEC, channel.volume, TAU);
    this.panLane = new AutoLane(ctx, key('pan'), CHANNEL_PAN_SPEC, channel.pan, TAU);
    this.volLane.bind(this.vol.gain);
    this.panLane.bind(this.panner.pan);
    this.pitch = channel.kind === 'instrument' ? new PitchSignal(ctx, key('pitch'), channel.pitch ?? 0) : null;
    for (const lane of [this.volLane, this.panLane, this.pitch?.lane])
      if (lane) this.unregister.push(core.params.register(lane));
    this.input.connect(this.vol).connect(this.panner).connect(this.out);
    this.out.connect(core.insertInput(channel.output));
    this.setShift(core.channelShift(channel.output));
    this.load(channel, project);
  }

  /** The insert this channel plays through. */
  get outputId(): InsertId {
    return this.channel.output;
  }

  /**
   * Seconds the song's events for this channel (notes, clip starts) are scheduled later than the song says: the
   * mixer's delay compensation is done here, in time, not with a delay line on the audio (a live note, which is not
   * scheduled by the song, then hears none of it). The channel's automation lanes and its plugin's transport
   * anchors move by the same amount, so they stay with the notes.
   */
  get shift(): number {
    return this.shiftSec;
  }

  /** Returns whether the shift changed. */
  setShift(seconds: number): boolean {
    if (seconds === this.shiftSec) return false;
    this.shiftSec = seconds;
    this.volLane.shift = seconds;
    this.panLane.shift = seconds;
    if (this.pitch) this.pitch.lane.shift = seconds;
    this.liveHost?.setShift(seconds);
    return true;
  }

  /**
   * Resolves once the instrument is ready. Audio clip channels are ready at once: their samples and
   * stretched copies are the engine's residency's (Engine.ready and offline renders wait for those).
   */
  get ready(): Promise<void> {
    return this.pending;
  }

  /** Audio-clip channels: buffers arrived (a waiting clip starts, a stretched copy swaps in). */
  buffersChanged(): void {
    try {
      this.clipPlayer?.refresh();
    } catch (err) {
      this.fault(err);
    }
  }

  /**
   * Audio-clip channels: the clip launcher is about to play this sample, which no playlist clip may need: have it
   * decoded (and kept) before the first pass starts. With `pass` (the clip of the first pass and the tempo it plays under), a
   * 'stretch' channel also gets its time-stretched copy started, the one the playlist would make for that clip.
   */
  warm(pass?: { clip: AudioClip; tempo: TempoMap }): void {
    const ch = this.channel;
    if (ch.kind !== 'audioClip') return;
    const ref = this.project.samples[ch.sampleId];
    if (!ref) return;
    const mode = playbackMode(ch);
    this.core.residency.request(ref, mode.reverse, ch.id);
    if (pass && mode.follow === 'stretch')
      this.core.residency.stretched(pass.clip, stretchScale(mode, pass.tempo, pass.clip.start), pass.tempo);
  }

  /** Audio-clip channels: frees the buffers of finished voices. */
  sweep(): void {
    this.clipPlayer?.sweep();
  }

  update(next: InstrumentChannel | AudioClipChannel, project: Project): void {
    const prev = this.channel;
    this.channel = next;
    this.project = project;
    const t = this.core.ctx.currentTime;
    if (prev.volume !== next.volume) this.volLane.setBase(next.volume, t);
    if (prev.pan !== next.pan) this.panLane.setBase(next.pan, t);
    if (next.kind === 'instrument' && (prev.kind !== 'instrument' || prev.pitch !== next.pitch))
      this.pitch?.lane.setBase(next.pitch ?? 0, t);
    if (prev.output !== next.output) {
      this.out.disconnect();
      this.out.connect(this.core.insertInput(next.output));
      this.setShift(this.core.channelShift(next.output));
    }
    if (prev.kind !== next.kind) {
      this.load(next, project);
      return;
    }
    // Audio clip channels read their sample through the residency at each clip start.
    if (next.kind === 'audioClip') return;
    if (prev.kind !== 'instrument') return;
    if (prev.plugin.pluginId !== next.plugin.pluginId) {
      this.load(next, project);
      return;
    }
    if (prev.rootKey !== next.rootKey) this.host?.setRootKey(next.rootKey);
    if (prev.plugin !== next.plugin) this.host?.apply(next.plugin, project, t);
  }

  /** The project's sample table changed (a sample was added or replaced). */
  samplesChanged(project: Project): void {
    this.project = project;
    if (this.channel.kind !== 'audioClip') this.host?.apply(this.channel.plugin, project, this.core.ctx.currentTime);
  }

  /**
   * Automation now drives this channel's instrument: an instance running as the lite processor (no
   * AudioParams, see HostDeps.lite) is replaced by a full one so automation can move its params.
   */
  automationChanged(project: Project): void {
    this.project = project;
    if (this.host?.lite && automatedOwners(project.channels).has(ownerKey({ kind: 'channel', channelId: this.channel.id })))
      this.load(this.channel, project);
  }

  /** Re-creates the instrument (plugin code was hot-reloaded). */
  reload(project: Project): void {
    this.project = project;
    this.load(this.channel, project);
  }

  get pluginId(): string {
    return this.channel.kind === 'instrument' ? this.channel.plugin.pluginId : '';
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.out.gain.setTargetAtTime(muted ? 0 : 1, this.core.ctx.currentTime, 0.003);
  }

  noteOn(e: NoteOn): void {
    if (!this.instance) return;
    try {
      this.instance.noteOn(e);
    } catch (err) {
      this.fault(err);
    }
  }

  /** An audio clip starts (audio-clip channels; anything else hears a plain note-on). */
  audioOn(e: AudioOn): void {
    if (!this.clipPlayer) {
      this.noteOn(e);
      return;
    }
    try {
      this.clipPlayer.startClip(e);
    } catch (err) {
      this.fault(err);
    }
  }

  noteOff(e: NoteOff): void {
    try {
      this.instance?.noteOff(e);
    } catch (err) {
      this.fault(err);
    }
  }

  allNotesOff(time: number, hard = false): void {
    try {
      this.instance?.allNotesOff(time, hard);
    } catch (err) {
      this.fault(err);
    }
  }

  get tailTime(): number {
    return this.instance?.tailTime ?? 0.5;
  }

  /** A MIDI control change for the instrument. */
  controlChange(cc: number, value: number, time: number): void {
    try {
      this.instance?.controlChange?.(cc, value, time);
    } catch (err) {
      this.fault(err);
    }
  }

  /** Live pitch bend in cents (MIDI input). */
  setBend(cents: number, time: number): void {
    this.pitch?.setBend(cents, time);
  }

  dispose(): void {
    this.generation++;
    this.disposePlugin();
    for (const off of this.unregister) off();
    this.volLane.dispose();
    this.panLane.dispose();
    this.pitch?.dispose();
    this.out.disconnect();
    this.panner.disconnect();
    this.vol.disconnect();
    this.input.disconnect();
  }

  private load(channel: InstrumentChannel | AudioClipChannel, project: Project): void {
    const gen = ++this.generation;
    this.disposePlugin();
    if (channel.kind === 'audioClip') {
      this.pending = Promise.resolve();
      const residency = this.core.residency;
      const ch = () => this.channel as AudioClipChannel;
      // A clip with a pitch correction plays the render of it; everything else the channel's own sample.
      const ref = (clip?: AudioClip) => this.project.samples[clipSampleId(ch(), clip)] ?? this.project.samples[ch().sampleId];
      const inst = createClipPlayer(this.core.ctx, {
        mode: () => playbackMode(ch()),
        base: (clip) => {
          const r = ref(clip);
          if (!r) return null;
          const reverse = playbackMode(ch()).reverse;
          const buffer = residency.base(r, reverse);
          return buffer ? { buffer, key: residency.baseKey(r, reverse) } : null;
        },
        stretched: (clip, scale, tempo) => residency.stretched(clip, scale, tempo),
        request: (clip) => {
          const r = ref(clip);
          if (r) residency.request(r, playbackMode(ch()).reverse, ch().id);
        },
        hold: (key) => residency.hold(key),
      });
      inst.output.connect(this.input);
      this.instance = inst;
      this.clipPlayer = inst;
      this.faulted = false;
      return;
    }
    const def = this.core.plugins.get(channel.plugin.pluginId);
    if (!def || def.kind !== 'instrument') {
      this.faulted = true;
      this.pending = Promise.resolve();
      if (!def) this.core.reportFault({ kind: 'channel', channelId: channel.id }, channel.plugin.pluginId, 'missing');
      return;
    }
    const host = new HostImpl({
      ctx: this.core.ctx,
      def,
      data: channel.plugin,
      project,
      samples: this.core.samples,
      transport: this.core.transportInfo,
      rootKey: channel.rootKey,
      ...(this.pitch ? { pitch: this.pitch } : {}),
      offline: this.core.offline,
      registry: this.core.params,
      requestState: (state: JsonValue) => this.core.requestState({ kind: 'channel', channelId: channel.id }, state),
      owner: { kind: 'channel', channelId: channel.id },
      loadModule: (url) => this.core.loadModule(url),
      ports: this.core.ports,
      reportFault: (err) => this.fault(err),
      reportTap: (tap, live) => this.core.reportTap?.({ kind: 'channel', channelId: channel.id }, tap, live),
      lite: () => !automatedOwners(this.project.channels).has(ownerKey({ kind: 'channel', channelId: channel.id })),
    });
    host.setShift(this.shiftSec);
    this.liveHost = host;
    this.pending = (async () => {
      try {
        const inst = await def.create(host);
        if (gen !== this.generation) {
          inst.dispose();
          host.dispose();
          return;
        }
        inst.output.connect(this.input);
        host.onState = (s) => inst.setState?.(s as never);
        this.instance = inst;
        this.host = host;
        this.faulted = false;
        // Catch up with edits made while the plugin was loading.
        if (this.channel.kind === 'instrument') {
          host.setRootKey(this.channel.rootKey);
          host.apply(this.channel.plugin, this.project, this.core.ctx.currentTime);
        }
      } catch (err) {
        host.dispose();
        if (gen === this.generation) this.fault(err);
      }
    })();
  }

  private disposePlugin(): void {
    const inst = this.instance;
    const host = this.host;
    this.instance = null;
    this.clipPlayer = null;
    this.host = null;
    this.liveHost = null;
    if (inst) {
      try {
        inst.allNotesOff(this.core.ctx.currentTime, true);
        inst.output.disconnect();
        inst.dispose();
      } catch (err) {
        console.error('plugin dispose failed', err);
      }
    }
    host?.dispose();
  }

  private fault(err: unknown): void {
    this.faulted = true;
    this.core.reportFault({ kind: 'channel', channelId: this.channel.id }, this.pluginId, err);
  }
}
