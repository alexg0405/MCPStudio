import type { InstrumentChannel, Project } from '@core/model/types';
import type { InstrumentInstance, JsonValue, NoteOff, NoteOn } from '@agstudio/sdk';
import { HostImpl } from './host';
import type { EngineCore } from './engine-core';

/**
 * A channel in the channel rack: instrument → volume → pan → mute → its mixer insert.
 * Plugin creation is async; until it resolves, notes are dropped.
 */
export class ChannelStrip {
  readonly input: GainNode;
  private readonly vol: GainNode;
  private readonly panner: StereoPannerNode;
  readonly out: GainNode;
  private instance: InstrumentInstance | null = null;
  private host: HostImpl | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private muted = false;
  private channel: InstrumentChannel;
  private project: Project;
  /** True when the plugin is missing or failed to load (silent placeholder; data is kept). */
  faulted = false;

  constructor(
    private readonly core: EngineCore,
    channel: InstrumentChannel,
    project: Project,
  ) {
    const ctx = core.ctx;
    this.channel = channel;
    this.project = project;
    this.input = new GainNode(ctx);
    this.vol = new GainNode(ctx, { gain: channel.volume });
    this.panner = new StereoPannerNode(ctx, { pan: channel.pan });
    this.out = new GainNode(ctx);
    this.input.connect(this.vol).connect(this.panner).connect(this.out);
    this.out.connect(core.insertInput(channel.output));
    this.load(channel, project);
  }

  get ready(): Promise<void> {
    return this.pending;
  }

  update(next: InstrumentChannel, project: Project): void {
    const prev = this.channel;
    this.channel = next;
    this.project = project;
    const t = this.core.ctx.currentTime;
    if (prev.volume !== next.volume) this.vol.gain.setTargetAtTime(next.volume, t, 0.004);
    if (prev.pan !== next.pan) this.panner.pan.setTargetAtTime(next.pan, t, 0.004);
    if (prev.output !== next.output) {
      this.out.disconnect();
      this.out.connect(this.core.insertInput(next.output));
    }
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
    this.host?.apply(this.channel.plugin, project, this.core.ctx.currentTime);
  }

  /** Re-creates the instrument (plugin code was hot-reloaded). */
  reload(project: Project): void {
    this.project = project;
    this.load(this.channel, project);
  }

  get pluginId(): string {
    return this.channel.plugin.pluginId;
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

  dispose(): void {
    this.generation++;
    this.disposePlugin();
    this.out.disconnect();
    this.panner.disconnect();
    this.vol.disconnect();
    this.input.disconnect();
  }

  private load(channel: InstrumentChannel, project: Project): void {
    const gen = ++this.generation;
    this.disposePlugin();
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
      offline: this.core.offline,
      requestState: (state: JsonValue) => this.core.requestState({ kind: 'channel', channelId: channel.id }, state),
      owner: { kind: 'channel', channelId: channel.id },
      loadModule: (url) => this.core.loadModule(url),
      ports: this.core.ports,
      reportFault: (err) => this.fault(err),
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
        host.setRootKey(this.channel.rootKey);
        host.apply(this.channel.plugin, this.project, this.core.ctx.currentTime);
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
    this.core.reportFault({ kind: 'channel', channelId: this.channel.id }, this.channel.plugin.pluginId, err);
  }
}
