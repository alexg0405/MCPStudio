import { CHANNEL_PAN_SPEC, CHANNEL_VOLUME_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import { automatedOwners, ownerKey } from '@core/automation/owners';
import type { AudioClip, AudioClipChannel, InsertId, InstrumentChannel, Project } from '@core/model/types';
import { clipSampleId, playbackMode, stretchScale } from '@core/audio/playback';
import type { TempoMap } from '@core/time/ppq';
import type { AnyInstrumentDef, InstrumentInstance, JsonValue, NoteOff, NoteOn } from '@agstudio/sdk';
import { HostImpl } from './host';
import { createClipPlayer, type ClipPlayer } from './clip-player';
import type { EngineCore } from './engine-core';
import { AutoLane } from './param-lane';
import { PitchSignal } from './pitch-signal';
import type { AudioOn } from './sched/transport';

/** Time constant of channel volume and pan moves (seconds). */
const CHANNEL_GLIDE_TAU_SEC = 0.004;
/** Time constant of a mute or unmute (seconds): fast, but without a click. */
const MUTE_GLIDE_TAU_SEC = 0.003;
/** What an instrument that has not loaded (or failed) is assumed to ring for after its last note (seconds). */
const DEFAULT_TAIL_SEC = 0.5;

/**
 * A channel in the channel rack: instrument → volume → pan → [mute] → its mixer insert.
 * Plugin creation is async; until it resolves, notes are dropped. The mute gate is made the first time the channel is
 * muted: a gain at 1 does nothing but cost the audio thread time on every block, and nearly no channel is muted.
 */
export class ChannelStrip {
  private readonly vol: GainNode;
  private readonly panner: StereoPannerNode;
  /** The mute gate (see the class comment); null until the channel is first muted. */
  private muteGate: GainNode | null = null;
  /** Takes `out` off the mix of the insert it plays into. */
  private detachFromInsert: () => void;
  /** `out` is off the insert's mix because the instrument sleeps (see park()). */
  private isParked = false;
  /** Stops listening to the instrument's sleep (see watchSleep). */
  private stopWatchingSleep: () => void = () => {};
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
    this.vol = new GainNode(ctx);
    this.panner = new StereoPannerNode(ctx);
    const key = (param: 'volume' | 'pan' | 'pitch') => targetKey({ kind: 'channel', channelId: channel.id, param });
    this.volLane = new AutoLane(ctx, key('volume'), CHANNEL_VOLUME_SPEC, channel.volume, CHANNEL_GLIDE_TAU_SEC);
    this.panLane = new AutoLane(ctx, key('pan'), CHANNEL_PAN_SPEC, channel.pan, CHANNEL_GLIDE_TAU_SEC);
    this.volLane.bind(this.vol.gain);
    this.panLane.bind(this.panner.pan);
    this.pitch = channel.kind === 'instrument' ? new PitchSignal(ctx, key('pitch'), channel.pitch ?? 0) : null;
    for (const lane of [this.volLane, this.panLane, this.pitch?.lane])
      if (lane) this.unregister.push(core.params.register(lane));
    this.vol.connect(this.panner);
    this.detachFromInsert = core.insertInput(channel.output).attach(this.tail);
    this.setShift(core.channelShift(channel.output));
    this.load(channel, project);
  }

  /** Where the instrument's output joins the strip (its volume node: the strip has no node of its own for it). */
  private get entry(): GainNode {
    return this.vol;
  }

  /** The last node of the strip: what the insert's mix takes. */
  private get tail(): AudioNode {
    return this.muteGate ?? this.panner;
  }

  /** The instrument says it has no voices and no tail: nothing can come out of this channel until its next note. */
  get isIdle(): boolean {
    return this.instance?.sleep?.asleep === true;
  }

  /** The channel is out of the audio graph (see park()). */
  get parked(): boolean {
    return this.isParked;
  }

  /**
   * Takes the channel's output off its insert's mix while the instrument sleeps. Nothing downstream of a node's
   * output is pulled once nothing is connected beyond it, so the instrument, volume, pan and mute nodes are no longer
   * processed. Idle parking (engine/idle-parking.ts) parks and unparks; a note brings the channel back before it is due.
   */
  park(): void {
    if (this.isParked) return;
    this.isParked = true;
    this.detachFromInsert();
    this.detachFromInsert = () => {};
    this.liveHost?.setParked(true);
  }

  /** Puts the channel's output back on its insert's mix. */
  unpark(): void {
    if (!this.isParked) return;
    this.isParked = false;
    this.detachFromInsert = this.core.insertInput(this.channel.output).attach(this.tail);
    this.liveHost?.setParked(false);
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
      this.pitch?.setKnob(next.pitch ?? 0, t);
    if (prev.output !== next.output) {
      this.detachFromInsert();
      this.detachFromInsert = this.isParked ? () => {} : this.core.insertInput(next.output).attach(this.tail);
      this.setShift(this.core.channelShift(next.output));
      this.core.idle?.rewired();
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

  /** Puts the mute gate between the pan and the insert (at gain 1, so nothing changes until it moves). */
  private ensureMuteGate(): GainNode {
    if (this.muteGate) return this.muteGate;
    const gate = new GainNode(this.core.ctx);
    this.detachFromInsert();
    this.panner.connect(gate);
    this.muteGate = gate;
    this.detachFromInsert = this.isParked ? () => {} : this.core.insertInput(this.channel.output).attach(gate);
    return gate;
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.ensureMuteGate().gain.setTargetAtTime(muted ? 0 : 1, this.core.ctx.currentTime, MUTE_GLIDE_TAU_SEC);
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
    return this.instance?.tailTime ?? DEFAULT_TAIL_SEC;
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
    this.stopWatchingSleep();
    this.disposePlugin();
    for (const off of this.unregister) off();
    this.volLane.dispose();
    this.panLane.dispose();
    this.pitch?.dispose();
    this.detachFromInsert();
    this.muteGate?.disconnect();
    this.panner.disconnect();
    this.vol.disconnect();
  }

  /** Replaces what the channel plays with: the clip player of an audio clip channel, or its instrument plugin. */
  private load(channel: InstrumentChannel | AudioClipChannel, project: Project): void {
    const generation = ++this.generation;
    this.stopWatchingSleep();
    this.disposePlugin();
    // A new instrument starts awake, whatever the old one was doing.
    this.unpark();
    if (channel.kind === 'audioClip') {
      this.loadClipPlayer();
      return;
    }
    const def = this.core.plugins.get(channel.plugin.pluginId);
    if (!def || def.kind !== 'instrument') {
      this.faulted = true;
      this.pending = Promise.resolve();
      if (!def) this.core.reportFault({ kind: 'channel', channelId: channel.id }, channel.plugin.pluginId, 'missing');
      return;
    }
    const host = this.createHost(def, channel, project);
    host.setShift(this.shiftSec);
    this.liveHost = host;
    this.pending = this.instantiate(def, host, generation);
  }

  /** An audio clip channel plays through a clip player that reads its buffers from the engine's residency. */
  private loadClipPlayer(): void {
    this.pending = Promise.resolve();
    const residency = this.core.residency;
    const channel = () => this.channel as AudioClipChannel;
    // A clip with a pitch correction plays the render of it; everything else the channel's own sample.
    const sampleOf = (clip?: AudioClip) =>
      this.project.samples[clipSampleId(channel(), clip)] ?? this.project.samples[channel().sampleId];
    const player = createClipPlayer(this.core.ctx, {
      mode: () => playbackMode(channel()),
      base: (clip) => {
        const sample = sampleOf(clip);
        if (!sample) return null;
        const reverse = playbackMode(channel()).reverse;
        const buffer = residency.base(sample, reverse);
        return buffer ? { buffer, key: residency.baseKey(sample, reverse) } : null;
      },
      stretched: (clip, scale, tempo) => residency.stretched(clip, scale, tempo),
      request: (clip) => {
        const sample = sampleOf(clip);
        if (sample) residency.request(sample, playbackMode(channel()).reverse, channel().id);
      },
      hold: (key) => residency.hold(key),
    });
    player.output.connect(this.entry);
    this.instance = player;
    this.clipPlayer = player;
    this.faulted = false;
  }

  private createHost(def: AnyInstrumentDef, channel: InstrumentChannel, project: Project): HostImpl {
    const owner = { kind: 'channel', channelId: channel.id } as const;
    return new HostImpl({
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
      requestState: (state: JsonValue) => this.core.requestState(owner, state),
      owner,
      loadModule: (url) => this.core.loadModule(url),
      ports: this.core.ports,
      reportFault: (err) => this.fault(err),
      reportTap: (tap, live) => this.core.reportTap?.(owner, tap, live),
      lite: () => !automatedOwners(this.project.channels).has(ownerKey(owner)),
    });
  }

  /** Creates the instrument, and makes it the channel's own unless a newer load has started meanwhile. */
  private async instantiate(def: AnyInstrumentDef, host: HostImpl, generation: number): Promise<void> {
    try {
      const instance = await def.create(host);
      if (generation !== this.generation) {
        instance.dispose();
        host.dispose();
        return;
      }
      instance.output.connect(this.entry);
      host.onState = (state) => instance.setState?.(state as never);
      this.instance = instance;
      this.host = host;
      this.faulted = false;
      this.watchSleep(instance);
      // Catch up with edits made while the plugin was loading.
      if (this.channel.kind === 'instrument') {
        host.setRootKey(this.channel.rootKey);
        host.apply(this.channel.plugin, this.project, this.core.ctx.currentTime);
      }
    } catch (err) {
      host.dispose();
      if (generation === this.generation) this.fault(err);
    }
  }

  /** Idle parking hears when the instrument wakes (it brings the channel back at once) and when it falls asleep (it looks on its next tick). */
  private watchSleep(instance: InstrumentInstance): void {
    this.stopWatchingSleep = instance.sleep?.onChange((asleep) => {
      if (asleep) this.core.idle?.slept();
      else this.core.idle?.changed();
    }) ?? (() => {});
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
