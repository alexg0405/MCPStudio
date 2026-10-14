import { CHANNEL_PAN_SPEC, CHANNEL_PITCH_SPEC, CHANNEL_VOLUME_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import type { AudioClipChannel, InstrumentChannel, Project } from '@core/model/types';
import type { InstrumentInstance, JsonValue, NoteOff, NoteOn, ParamSignal } from '@agstudio/sdk';
import { HostImpl } from './host';
import { createClipPlayer } from './clip-player';
import type { EngineCore } from './engine-core';
import { AutoLane } from './param-lane';

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
  private channel: InstrumentChannel | AudioClipChannel;
  private project: Project;
  /** Audio-clip channels: the sample being played. */
  private clipBuffer: AudioBuffer | null = null;
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
    this.load(channel, project);
  }

  get ready(): Promise<void> {
    return this.pending;
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
    }
    if (prev.kind !== next.kind) {
      this.load(next, project);
      return;
    }
    if (next.kind === 'audioClip') {
      if (prev.kind === 'audioClip' && prev.sampleId !== next.sampleId) this.loadClipBuffer(next, project);
      return;
    }
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
    if (this.channel.kind === 'audioClip') this.loadClipBuffer(this.channel, project);
    else this.host?.apply(this.channel.plugin, project, this.core.ctx.currentTime);
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

  private loadClipBuffer(channel: AudioClipChannel, project: Project): void {
    const ref = project.samples[channel.sampleId];
    if (!ref) {
      this.clipBuffer = null;
      return;
    }
    this.clipBuffer = this.core.samples.getSync(ref, this.core.ctx.sampleRate);
    if (!this.clipBuffer) {
      void this.core.samples.load(ref, this.core.ctx).then((b) => {
        if (this.channel.kind === 'audioClip' && this.channel.sampleId === channel.sampleId) this.clipBuffer = b;
      });
    }
  }

  private load(channel: InstrumentChannel | AudioClipChannel, project: Project): void {
    const gen = ++this.generation;
    this.disposePlugin();
    if (channel.kind === 'audioClip') {
      this.loadClipBuffer(channel, project);
      const inst = createClipPlayer(this.core.ctx, () => this.clipBuffer);
      inst.output.connect(this.input);
      this.instance = inst;
      this.faulted = false;
      this.pending = Promise.resolve();
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
    });
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
    this.host = null;
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
