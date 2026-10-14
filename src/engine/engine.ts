/**
 * The audio engine: owns the AudioContext (or an OfflineAudioContext for export), mirrors the
 * project document into a Web Audio graph and drives the lookahead transport.
 */
import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, PluginOwner, Project, SampleRef, Tick } from '@core/model/types';
import { effectivelyMuted } from '@core/query/queries';
import { tempoMapOf } from '@core/automation/tempo';
import { playbackKey, playbackMode, stretchScale } from '@core/audio/playback';
import { PPQ, constantTempo, ticksPerBar, type TempoMap } from '@core/time/ppq';
import type { AudioTap, JsonValue, ParamSpecs, TransportInfo } from '@agstudio/sdk';
import { INACTIVE_TAP, TapImpl } from './tap';
import type {
  EngineApi,
  EngineOptions,
  EngineSession,
  EngineState,
  EngineStats,
  PluginResolver,
  SampleData,
  TransportView,
} from './api';
import { AutomationDriver } from './automation/driver';
import { ChannelStrip } from './channel-strip';
import type { EngineCore } from './engine-core';
import { KernelTransportFeed } from './kernel-transport';
import { Metronome } from './metronome';
import { MixerGraph } from './mixer-graph';
import { ParamRegistry } from './param-lane';
import { SampleCache } from './samples';
import { decodeAudio } from './decode';
import { waveformOf, type Waveform } from './waveform';
import { startRecording, type RecordOptions, type RecordingHandle } from './recorder';
import { openAudioInput, type AudioInput } from './audio-input';
import type { Timeline } from './sched/core';
import { patternModeSource, songModeSource, type EventSource } from './sched/events';
import { Transport, type TransportSink } from './sched/transport';
import { LIMITER_ID } from './limiter-id';
import type { WorkletPortImpl } from './worklet-port';
import limiterUrl from './limiter.worklet.ts?worker&url';

const PREVIEW_ID_BASE = 2 ** 30;

const audioKeys = new WeakMap<Project['channels'], string>();

/** One string for how every audio clip channel plays (see playbackKey), memoized per channels record. */
function audioKeyOf(p: Project): string {
  let key = audioKeys.get(p.channels);
  if (key === undefined) {
    const parts: string[] = [];
    for (const id of p.channelOrder) {
      const ch = p.channels[id];
      if (ch?.kind === 'audioClip') parts.push(`${id}:${playbackKey(ch)}`);
    }
    key = parts.join(',');
    audioKeys.set(p.channels, key);
  }
  return key;
}

/**
 * Tempo as plugins see it: the tempo now, the tempo at a scheduled time (from the transport's
 * planned segments, so tempo automation is followed), and change notifications with the time the
 * new tempo starts at.
 */
class TempoInfo implements TransportInfo {
  readonly ppq = PPQ;
  private fns = new Set<(bpm: number, time: number) => void>();
  /** Seconds per tick → BPM at a context time (set once the transport exists). */
  sptAt: ((time: number) => number) | null = null;
  constructor(
    public bpm: number,
    private readonly clock: { readonly currentTime: number },
  ) {}
  tempoAt(time: number): number {
    const spt = this.sptAt?.(time);
    return spt ? Math.round((60 / (spt * PPQ)) * 1e6) / 1e6 : this.bpm;
  }
  onTempo(cb: (bpm: number, time: number) => void): () => void {
    this.fns.add(cb);
    return () => this.fns.delete(cb);
  }
  setBpm(bpm: number, time = this.clock.currentTime): void {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    for (const fn of this.fns) fn(bpm, time);
  }
}

/** The live worklet ports; a new one is told where the song is right away. */
class PortSet extends Set<WorkletPortImpl> {
  onAdd: ((port: WorkletPortImpl) => void) | null = null;
  override add(port: WorkletPortImpl): this {
    super.add(port);
    this.onAdd?.(port);
    return this;
  }
}

export class Engine implements EngineApi, EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  readonly offline: boolean;
  readonly transportInfo: TempoInfo;
  readonly params = new ParamRegistry();
  private readonly automation: AutomationDriver;
  private session: EngineSession = { metronome: false, countInBars: 0 };
  /** Post-master bus: master insert + previews → safety limiter → destination. */
  private readonly masterOut: GainNode;
  private readonly previewBus: GainNode;
  /** Metronome and count-in clicks: after the master track, before the limiter; never exported. */
  private readonly monitorBus: GainNode;
  private readonly metronome: Metronome | null;
  /** Inserts, routes, sidechains and delay compensation (engine/mixer-graph.ts). */
  readonly mixer: MixerGraph;
  private readonly strips = new Map<ChannelId, ChannelStrip>();
  private project: Project | null = null;
  private view: TransportView = { mode: 'pattern', patternId: null, loop: null };
  private readonly transport: Transport;
  private clock: Worker | null = null;
  private readonly listeners = new Set<() => void>();
  private previewSeq = PREVIEW_ID_BASE;
  private previewSource: AudioBufferSourceNode | null = null;
  private previewToken = 0;
  private readonly waveformsLoading = new Set<string>();
  private faults = 0;
  private muteKey = '';
  /** How every audio clip channel plays its sample (playing clips restart when it changes). */
  private audioKey = '';
  private lastLate = 0;
  private readonly modules = new Map<string, Promise<void>>();
  readonly ports = new PortSet();
  private readonly initDone: Promise<void>;
  private limiter: AudioWorkletNode | null = null;
  /** Scheduler cadence (see EngineStats.maxPumpGapMs). */
  private lastPumpAt = 0;
  private maxPumpGap = 0;
  /** Live inputs (closed with the engine). */
  private readonly inputs = new Set<AudioInput>();
  /** Song mode without a loop region plays past the end (recording) instead of looping. */
  private openEnded = false;
  private testClick: AudioBuffer | null = null;

  constructor(
    ctx: BaseAudioContext,
    private readonly opts: EngineOptions,
    offline = false,
    /** Offline renders may leave out the master safety limiter (renders that become clips again). */
    private readonly build: { limiter?: boolean } = {},
  ) {
    this.ctx = ctx;
    this.offline = offline;
    this.plugins = opts.plugins;
    this.samples = new SampleCache(opts.samples);
    this.transportInfo = new TempoInfo(130, ctx);
    this.masterOut = new GainNode(ctx);
    this.previewBus = new GainNode(ctx, { gain: 0.8 });
    this.masterOut.connect(ctx.destination);
    this.previewBus.connect(this.masterOut);
    this.monitorBus = new GainNode(ctx, { gain: 0.9 });
    this.monitorBus.connect(this.masterOut);
    this.mixer = new MixerGraph(this, this.masterOut, () => this.emit());

    const sink: TransportSink = {
      noteOn: (cid, e) => this.strips.get(cid)?.noteOn(e),
      audioOn: (cid, e) => this.strips.get(cid)?.audioOn(e),
      noteOff: (cid, e) => this.strips.get(cid)?.noteOff(e),
      allNotesOff: (time) => {
        for (const s of this.strips.values()) s.allNotesOff(time);
      },
    };
    const empty: EventSource = { project: null as unknown as Project, clips: [] };
    this.transport = new Transport(ctx, sink, empty, {
      tempo: constantTempo(130),
      loop: { start: 0, end: 1 },
      endTick: 1,
    });
    this.transport.onEnded = () => this.emit();
    this.transportInfo.sptAt = (time) => this.transport.sptAt(time);
    this.automation = new AutomationDriver({
      ctx,
      params: this.params,
      offline,
      specsOf: (pluginId) => this.plugins.get(pluginId)?.params as ParamSpecs | undefined,
      timeline: () => this.transport.currentTimeline,
    });
    this.transport.observe(this.automation);
    this.metronome = offline
      ? null
      : new Metronome(
          ctx,
          this.monitorBus,
          () => (this.project ? { tempo: this.tempoMap(), timeSig: this.project.transport.timeSig } : null),
          () => this.mixer.latency,
        );
    if (this.metronome) this.transport.observe(this.metronome);
    // Worklet kernels' view of the song (tempo-synced effects and instruments).
    const kernelTransport = new KernelTransportFeed({
      ports: this.ports,
      tickAt: (time) => this.transport.tickAt(time),
      baseBpm: () => this.transportInfo.bpm,
      now: () => this.ctx.currentTime,
    });
    this.transport.observe(kernelTransport);
    this.transportInfo.onTempo((bpm, time) => kernelTransport.tempoChanged(bpm, time));
    this.ports.onAdd = (port) => kernelTransport.adopt(port);
    // Tempo automation: tell tempo-synced plugins when the tempo of the planned segments changes.
    let lastSpt = 0;
    this.transport.observe({
      started: () => {
        lastSpt = 0;
      },
      segment: (seg) => {
        if (seg.spt !== lastSpt) {
          if (lastSpt !== 0) this.transportInfo.setBpm(Math.round((60 / (seg.spt * PPQ)) * 1e6) / 1e6, seg.time0);
          lastSpt = seg.spt;
        }
      },
      stopped: (time) => {
        if (this.project) this.transportInfo.setBpm(this.project.transport.bpm, time);
      },
    });

    if (!offline && typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      ctx.addEventListener('statechange', () => this.emit());
    }
    this.initDone = this.init();
  }

  /** Inserts the master safety limiter once its worklet module has loaded. */
  private async init(): Promise<void> {
    if (this.build.limiter === false) return;
    try {
      await this.loadModule(limiterUrl);
      const node = new AudioWorkletNode(this.ctx, LIMITER_ID, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { kind: 'effect', state: undefined, seed: 1 },
      });
      this.masterOut.disconnect();
      this.masterOut.connect(node).connect(this.ctx.destination);
      this.limiter = node;
    } catch (err) {
      console.warn('[agstudio] safety limiter unavailable; master is unprotected', err);
    }
  }

  loadModule(url: string): Promise<void> {
    let p = this.modules.get(url);
    if (!p) {
      p = this.ctx.audioWorklet.addModule(url);
      this.modules.set(url, p);
      p.catch(() => this.modules.delete(url));
    }
    return p;
  }

  /** Resolves once every worklet processor has handled all messages sent so far (export barrier). */
  async syncWorklets(timeoutMs = 2000): Promise<boolean> {
    const all = Promise.all([...this.ports].map((p) => p.sync())).then(() => true);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return Promise.race([all, timeout]);
  }

  /** Plugin definitions changed (hot reload, plugin added/removed): rebuild the affected instances. */
  pluginsChanged(ids: readonly string[]): void {
    if (!this.project || ids.length === 0) return;
    const set = new Set(ids);
    for (const strip of this.strips.values()) if (set.has(strip.pluginId)) strip.reload(this.project);
    this.mixer.pluginsChanged(set, this.project);
  }

  /** A realtime engine with its own AudioContext. */
  static realtime(opts: EngineOptions): Engine {
    return new Engine(new AudioContext({ latencyHint: 'interactive' }), opts, false);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get state(): EngineState {
    return this.ctx.state as EngineState;
  }

  get playing(): boolean {
    return this.transport.playing;
  }

  async resume(): Promise<void> {
    if (this.ctx instanceof AudioContext && this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Resolves when the master chain and every plugin instance (instruments and effects) have loaded. */
  async ready(): Promise<void> {
    await this.initDone;
    await Promise.all([...[...this.strips.values()].map((s) => s.ready), this.mixer.ready]);
  }

  // ---- Document mirroring ----

  applyDocChange(change: DocChange): void {
    const prev = change.origin === 'load' ? null : this.project;
    this.reconcile(prev, change.next);
  }

  private reconcile(prev: Project | null, next: Project): void {
    if (prev === next) return;
    this.project = next;
    if (!prev || prev.transport.bpm !== next.transport.bpm) this.transportInfo.setBpm(next.transport.bpm);

    // Inserts first (channels connect to them), removals last.
    const removedInserts = this.mixer.reconcile(prev, next);

    if (!prev || prev.channels !== next.channels || prev.samples !== next.samples) {
      const muted = effectivelyMuted(next.channels);
      for (const id of next.channelOrder) {
        const ch = next.channels[id];
        if (!ch || ch.kind === 'automation') continue;
        const strip = this.strips.get(id);
        if (!strip) this.strips.set(id, new ChannelStrip(this, ch, next));
        else {
          const prevCh = prev?.channels[id];
          if (prevCh !== ch) strip.update(ch, next);
          else if (prev && prev.samples !== next.samples) strip.samplesChanged(next);
        }
        this.strips.get(id)?.setMuted(muted.has(id));
      }
      for (const [id, strip] of this.strips) {
        const kind = next.channels[id]?.kind;
        if (kind !== 'instrument' && kind !== 'audioClip') {
          strip.dispose();
          this.strips.delete(id);
        }
      }
    }
    // Insert removals last; anything still routed to a removed insert falls back to the master.
    this.mixer.removeStrips(removedInserts);

    const muteKey = [...effectivelyMuted(next.channels)].sort().join(',');
    const audioKey = !prev || prev.channels !== next.channels ? audioKeyOf(next) : this.audioKey;
    const schedulingChanged =
      !prev ||
      prev.patterns !== next.patterns ||
      prev.playlist !== next.playlist ||
      prev.transport !== next.transport ||
      prev.channelOrder !== next.channelOrder ||
      muteKey !== this.muteKey ||
      audioKey !== this.audioKey;
    this.muteKey = muteKey;
    this.audioKey = audioKey;
    if (
      !prev ||
      prev.playlist !== next.playlist ||
      prev.channels !== next.channels ||
      prev.transport !== next.transport ||
      prev.samples !== next.samples
    )
      this.planStretches(next);
    // Automation first: a re-planning transport then schedules segments with the new curves.
    this.automation.update(next, this.view);
    if (schedulingChanged) this.updateModel();
  }

  /** Tells each audio clip channel in 'stretch' mode which stretched copies its clips need. */
  private planStretches(p: Project): void {
    const tempo = tempoMapOf(p, 'song');
    const scales = new Map<ChannelId, Set<number>>();
    for (const clip of Object.values(p.playlist.clips)) {
      if (clip.kind !== 'audio') continue;
      const ch = p.channels[clip.channelId];
      if (ch?.kind !== 'audioClip') continue;
      const mode = playbackMode(ch);
      if (mode.follow !== 'stretch') continue;
      const k = stretchScale(mode, tempo, clip.start);
      if (k === 1) continue;
      let set = scales.get(ch.id);
      if (!set) scales.set(ch.id, (set = new Set()));
      set.add(k);
    }
    for (const [id, strip] of this.strips) strip.setStretches([...(scales.get(id) ?? [])].sort((a, b) => a - b));
  }

  /** True while a time-stretched copy of the channel's sample is being computed. */
  isStretching(channelId: ChannelId): boolean {
    return this.strips.get(channelId)?.isStretching ?? false;
  }

  notify(): void {
    this.emit();
  }

  setTransportView(view: TransportView): void {
    if (
      view.mode === this.view.mode &&
      view.patternId === this.view.patternId &&
      view.loop?.start === this.view.loop?.start &&
      view.loop?.end === this.view.loop?.end
    )
      return;
    this.view = view;
    if (this.project) this.automation.update(this.project, view);
    this.updateModel();
  }

  private model(): { source: EventSource; timeline: Timeline } | null {
    const p = this.project;
    if (!p) return null;
    const tempo = tempoMapOf(p, this.view.mode);
    if (this.view.mode === 'song') {
      // Song mode loops the loop region, or the whole song (FL's default); while recording audio
      // without a loop region it plays on past the end.
      const { source, length } = songModeSource(p);
      const songEnd = Math.max(length, ticksPerBar(p.transport.timeSig));
      const region = this.view.loop && this.view.loop.end > this.view.loop.start ? this.view.loop : null;
      if (!region && this.openEnded) return { source, timeline: { tempo, loop: null, endTick: Number.MAX_SAFE_INTEGER } };
      return { source, timeline: { tempo, loop: region ?? { start: 0, end: songEnd }, endTick: songEnd } };
    }
    const { source, length } = patternModeSource(p, this.view.patternId ?? p.patternOrder[0] ?? null);
    return { source, timeline: { tempo, loop: { start: 0, end: length }, endTick: length } };
  }

  /** The tempo map playback uses now (song mode follows tempo automation). */
  tempoMap(): TempoMap {
    return this.project ? tempoMapOf(this.project, this.view.mode) : constantTempo(this.transportInfo.bpm);
  }

  private updateModel(): void {
    const m = this.model();
    if (m) this.transport.setModel(m.source, m.timeline);
  }

  // ---- EngineCore ----

  /** Where a channel routed to `id` connects (unknown inserts play through the master). */
  insertInput(id: InsertId): AudioNode {
    return this.mixer.insertInput(id);
  }

  requestState(owner: PluginOwner, state: JsonValue): void {
    this.opts.onPluginStateRequest?.(owner, state);
  }

  reportFault(owner: PluginOwner, pluginId: string, err: unknown): void {
    this.faults++;
    this.opts.onPluginFault?.(owner, pluginId, err);
    this.emit();
  }

  reportTap(owner: PluginOwner, tap: AudioTap, live: boolean): void {
    this.opts.onPluginTap?.(owner, tap, live);
  }

  // ---- Transport ----

  play(fromTick = 0): void {
    if (!this.project) return;
    void this.resume();
    this.updateModel();
    // Playing again while playing is a seek: what was scheduled is cancelled or released first.
    const at = this.ctx.currentTime + 0.05;
    if (this.transport.playing) this.transport.seek(fromTick, at);
    else {
      // Count-in (record mode): clicks first, then playback.
      const countIn =
        this.metronome && this.session.countInBars > 0
          ? this.metronome.countIn(
              at,
              this.session.countInBars,
              this.tempoMap().bpmAt(fromTick),
              this.project.transport.timeSig,
            )
          : 0;
      this.transport.start(fromTick, at + countIn);
    }
    this.startClock();
    this.emit();
  }

  stop(): void {
    this.transport.stop(0);
    this.stopClock();
    this.emit();
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    const ctx = this.ctx as BaseAudioContext & { setSinkId?(id: string): Promise<void> };
    if (this.offline || typeof ctx.setSinkId !== 'function') return false;
    try {
      await ctx.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  panic(): void {
    this.stop();
    const now = this.ctx.currentTime;
    for (const s of this.strips.values()) s.allNotesOff(now, true);
    for (const port of this.ports) port.reset();
    // Graph effects can't be flushed: duck the output while their tails ring out.
    const g = this.masterOut.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.01);
    g.setValueAtTime(0, now + 0.6);
    g.linearRampToValueAtTime(1, now + 0.65);
  }

  /** Offline rendering: start the transport on the virtual clock (call pumpOffline per chunk). */
  startOffline(fromTick: number, at: number): void {
    this.updateModel();
    this.transport.start(fromTick, at);
  }

  pumpOffline(horizon: number): void {
    this.transport.pump(horizon);
  }

  playhead(): number {
    return this.transport.positionAt(this.heardTime());
  }

  playheadIteration(): number {
    return this.transport.iterationAt(this.heardTime());
  }

  /**
   * The scheduling time of what is being heard: the audible time minus the mixer's latency (delay
   * compensation holds every path back to the longest one, so music scheduled at t is heard at
   * t + graphLatency).
   */
  private heardTime(): number {
    return this.audibleTime() - this.mixer.latency;
  }

  /** Context time currently coming out of the speakers. */
  private audibleTime(): number {
    const ctx = this.ctx;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
      return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency;
    }
    return ctx.currentTime;
  }

  private startClock(): void {
    if (this.offline) return;
    this.lastPumpAt = 0;
    if (!this.transport.playing || this.maxPumpGap < 0) this.maxPumpGap = 0;
    if (!this.clock) {
      this.clock = new Worker(new URL('./sched/clock.worker.ts', import.meta.url), { type: 'module' });
      this.clock.onmessage = () => this.tick();
    }
    this.clock.postMessage({ cmd: 'start', interval: 25 });
  }

  private stopClock(): void {
    this.clock?.postMessage({ cmd: 'stop' });
  }

  private tick(): void {
    const wasPlaying = this.transport.playing;
    const now = performance.now();
    if (wasPlaying && this.lastPumpAt > 0) this.maxPumpGap = Math.max(this.maxPumpGap, now - this.lastPumpAt);
    this.lastPumpAt = now;
    this.transport.pump();
    // Raise the lookahead when notes arrive late (main-thread jank).
    if (this.transport.lateEvents > this.lastLate) {
      this.lastLate = this.transport.lateEvents;
      this.transport.lookahead = Math.min(0.25, this.transport.lookahead * 1.5);
    }
    if (wasPlaying && !this.transport.playing) {
      this.stopClock();
      this.emit();
    }
  }

  // ---- Previews ----

  previewNoteOn(channelId: ChannelId, key: number, velocity = 0.8): number {
    void this.resume();
    const noteId = ++this.previewSeq;
    this.strips.get(channelId)?.noteOn({ time: this.ctx.currentTime, noteId, key, velocity });
    return noteId;
  }

  previewNoteOff(channelId: ChannelId, noteId: number): void {
    this.strips.get(channelId)?.noteOff({ time: this.ctx.currentTime, noteId, key: 0 });
  }

  previewControl(channelId: ChannelId, cc: number, value: number): void {
    this.strips.get(channelId)?.controlChange(cc, value, this.ctx.currentTime);
  }

  previewPitchBend(channelId: ChannelId, cents: number): void {
    this.strips.get(channelId)?.setBend(cents, this.ctx.currentTime);
  }

  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    void this.resume();
    void this.samples.load(ref, this.ctx).then((buffer) => {
      if (buffer) this.playPreview(buffer);
    });
  }

  async record(
    stream: MediaStream,
    opts: RecordOptions & { playAlong: boolean; fromTick?: Tick },
  ): Promise<RecordingHandle> {
    const ctx = this.ctx;
    if (typeof AudioContext === 'undefined' || !(ctx instanceof AudioContext))
      throw new Error('Recording needs the realtime engine.');
    await this.resume();
    this.stop();
    // Count in at the tempo where playback starts (tempo automation can change it later).
    const bpm = this.project ? this.tempoMap().bpmAt(opts.fromTick ?? 0) : opts.bpm;
    const handle = await startRecording(
      ctx,
      (url) => this.loadModule(url),
      stream,
      { ...opts, bpm: opts.playAlong ? bpm : opts.bpm },
      this.previewBus,
    );
    if (opts.playAlong && this.project) {
      this.updateModel();
      this.transport.start(opts.fromTick ?? 0, handle.barOneTime);
      this.startClock();
      this.emit();
      handle.done.then(
        () => this.stop(),
        () => this.stop(),
      );
    }
    return handle;
  }

  async openAudioInput(
    stream: MediaStream,
    opts: { channels: 1 | 2; label?: string; latency?: number },
  ): Promise<AudioInput> {
    const ctx = this.ctx;
    if (typeof AudioContext === 'undefined' || !(ctx instanceof AudioContext))
      throw new Error('Recording needs the realtime engine.');
    await this.resume();
    const input = await openAudioInput(
      ctx,
      {
        loadModule: (url) => this.loadModule(url),
        insertInput: (id) => this.insertInput(id),
        // Output latency plus the master limiter's look-ahead (music and clicks pass through it).
        outputLatency: () => ctx.baseLatency + (ctx.outputLatency || 0) + Math.round(0.0013 * ctx.sampleRate) / ctx.sampleRate,
      },
      stream,
      opts,
    );
    const close = input.close.bind(input);
    input.close = () => {
      this.inputs.delete(input);
      close();
    };
    this.inputs.add(input);
    return input;
  }

  playTestClicks(count: number, interval: number): number[] {
    const ctx = this.ctx;
    if (!this.testClick) {
      const n = Math.round(0.004 * ctx.sampleRate);
      const b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: ctx.sampleRate });
      const d = b.getChannelData(0);
      // A sharp, loud-ish tick: easy to find in a recording.
      for (let i = 0; i < n; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 2000 * i) / ctx.sampleRate) * Math.exp(-i / (0.001 * ctx.sampleRate));
      this.testClick = b;
    }
    const t0 = ctx.currentTime + 0.3;
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = t0 + i * interval;
      const src = new AudioBufferSourceNode(ctx, { buffer: this.testClick });
      src.connect(this.monitorBus);
      src.onended = () => src.disconnect();
      src.start(at);
      times.push(at);
    }
    return times;
  }

  setSongOpenEnded(on: boolean): void {
    if (on === this.openEnded) return;
    this.openEnded = on;
    this.updateModel();
  }

  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null {
    const buffer = this.samples.getSync(ref, this.ctx.sampleRate);
    if (buffer) return waveformOf(buffer);
    const key = ref.source.kind === 'embedded' ? ref.source.hash : ref.source.generator;
    if (!this.waveformsLoading.has(key)) {
      this.waveformsLoading.add(key);
      void this.samples.load(ref, this.ctx).then((b) => {
        if (b) this.emit();
      });
    }
    return null;
  }

  async sampleData(ref: Pick<SampleRef, 'source' | 'name'>): Promise<SampleData | null> {
    const buffer = await this.samples.load(ref, this.ctx);
    if (!buffer) return null;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return { sampleRate: buffer.sampleRate, channels, duration: buffer.duration };
  }

  async previewAudio(bytes: ArrayBuffer): Promise<boolean> {
    void this.resume();
    const token = ++this.previewToken;
    let buffer: AudioBuffer;
    try {
      buffer = await decodeAudio(this.ctx, bytes);
    } catch {
      return false;
    }
    // A newer preview (or a stop) was requested while this one decoded.
    if (token === this.previewToken) this.playPreview(buffer);
    return true;
  }

  stopPreview(): void {
    this.previewToken++;
    try {
      this.previewSource?.stop();
    } catch {
      /* already stopped */
    }
    this.previewSource = null;
  }

  private playPreview(buffer: AudioBuffer): void {
    this.stopPreview();
    const src = new AudioBufferSourceNode(this.ctx, { buffer });
    src.connect(this.previewBus);
    src.onended = () => src.disconnect();
    src.start();
    this.previewSource = src;
  }

  // ---- Meters ----

  readMeters(order: readonly InsertId[], out: Float32Array): void {
    this.mixer.readMeters(order, out);
  }

  // ---- Timeline, automation, session ----

  tickAt(contextTime: number): { tick: number; iter: number } {
    // What is heard at t was scheduled at t − latency (delay compensation holds the music back).
    return this.transport.tickAt(contextTime - this.mixer.latency);
  }

  contextTimeAt(performanceMs: number): number {
    const ctx = this.ctx;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0)
        return ts.contextTime + (performanceMs - ts.performanceTime) / 1000;
      return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency + (performanceMs - performance.now()) / 1000;
    }
    return ctx.currentTime;
  }

  readAutomation(keys: readonly string[], out: Float64Array): void {
    const t = this.heardTime();
    for (let i = 0; i < keys.length && i < out.length; i++) out[i] = this.automation.readValue(keys[i] as string, t);
  }

  touch(key: string, on: boolean): void {
    this.automation.touch(key, on);
  }

  tempoNow(): number {
    return this.transportInfo.tempoAt(this.heardTime());
  }

  setSession(session: EngineSession): void {
    this.session = { ...session };
    if (this.metronome) this.metronome.enabled = session.metronome;
  }

  /** Session settings in effect (metronome, count-in). */
  get sessionSettings(): EngineSession {
    return this.session;
  }

  graphLatency(): number {
    return this.mixer.latency;
  }

  private outTap: TapImpl | null = null;
  outputTap(): AudioTap {
    if (this.offline) return INACTIVE_TAP;
    return (this.outTap ??= new TapImpl(this.ctx, this.masterOut, { fftSize: 4096, smoothing: 0.8 }));
  }

  // ---- Status ----

  stats(): EngineStats {
    const ctx = this.ctx;
    const realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    return {
      state: this.state,
      sampleRate: ctx.sampleRate,
      baseLatency: realtime ? ctx.baseLatency : 0,
      outputLatency: realtime ? ctx.outputLatency || 0 : 0,
      lookahead: this.transport.lookahead,
      lateEvents: this.transport.lateEvents,
      maxPumpGapMs: Math.round(this.maxPumpGap),
      faults: this.faults,
    };
  }

  /**
   * Seconds of tail to add after the last note when exporting: the longest instrument release plus
   * the effect tails along the deepest route path (capped at 30 s), plus the mixer's latency.
   */
  tailSeconds(): number {
    let tail = 0.5;
    for (const s of this.strips.values()) tail = Math.max(tail, s.tailTime);
    return Math.min(30, tail + this.mixer.tailSeconds()) + this.mixer.latency;
  }

  /** Seconds of the first bar (export/test helper; later bars can differ with tempo automation). */
  barSeconds(): number {
    const p = this.project;
    if (!p) return 0;
    return this.tempoMap().tickToSeconds(ticksPerBar(p.transport.timeSig));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async dispose(): Promise<void> {
    this.transport.stop();
    this.automation.dispose();
    this.metronome?.dispose();
    this.clock?.terminate();
    this.clock = null;
    for (const s of this.strips.values()) s.dispose();
    this.strips.clear();
    this.mixer.dispose();
    for (const p of [...this.ports]) p.dispose();
    for (const input of [...this.inputs]) input.close();
    this.limiter?.port.postMessage({ t: 'dispose' });
    this.outTap?.dispose();
    this.listeners.clear();
    if (typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext && this.ctx.state !== 'closed') {
      await this.ctx.close();
    }
  }
}
