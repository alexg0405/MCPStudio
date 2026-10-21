/**
 * The audio engine: owns the AudioContext (or an OfflineAudioContext for export), mirrors the
 * project document into a Web Audio graph and drives the lookahead transport.
 *
 * The engine is the facade the app talks to (`EngineApi`). The work is split between collaborators that each have
 * one job: the mixer graph (`MixerGraph`), the channel strips (`ChannelStrip`), the transport and its scheduler
 * clock (`Transport`, `SchedulerClock`), starting, stopping and following them (`TransportDriver`), what offline
 * renders call (`OfflineHooks`), the buses and limiter after the master (`OutputStage`), the clip launcher link,
 * previews, recording and the metering suite.
 */
import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, PluginInstance, PluginOwner, Project, SampleId, SampleRef } from '@core/model/types';
import { constantTempo, ticksPerBar, type TempoMap } from '@core/time/ppq';
import type { LaunchClock, LaunchDriver } from '@core/launcher/run';
import type { AudioTap, JsonValue, OrderedMix, ParamSpecs } from '@agstudio/sdk';
import type {
  DeckHost,
  EngineApi,
  EngineOptions,
  EngineSession,
  EngineState,
  EngineStats,
  MeterHandle,
  PluginResolver,
  PreviewOptions,
  SampleData,
  TransportView,
} from './api';
import { AutomationDriver } from './automation/driver';
import type { ChannelStrip } from './channel-strip';
import type { EngineCore } from './engine-core';
import { IdleParking } from './idle-parking';
import { KernelTransportFeed } from './kernel-transport';
import { LauncherLink } from './launcher-link';
import { createLiveMidiFx } from './live-fx-link';
import type { LiveFxOutput, LiveMidiFx } from './live-midi-fx';
import { LiveCapture, type RecordAlongOptions } from './live-capture';
import { LiveMeters } from './live-meters';
import { Metronome } from './metronome';
import { MixerGraph } from './mixer-graph';
import { NoteFeedHub } from './note-feed';
import { NotePreview } from './note-preview';
import { OfflineHooks } from './offline-hooks';
import { OutputClock } from './output-clock';
import { OutputStage } from './output-stage';
import { ParamRegistry } from './param-lane';
import { PortSet } from './port-set';
import { ProjectMirror } from './project-mirror';
import { isRealtimeContext } from './realtime-context';
import { SampleResidency } from './sample-residency';
import { SamplePreview } from './sample-preview';
import { SampleCache } from './samples';
import { SchedulerClock, PumpMonitor } from './scheduler-clock';
import type { EventSource } from './sched/events';
import { withRackPlugin } from './rack/rack-def';
import { Transport } from './sched/transport';
import { SongNoteSink } from './song-note-sink';
import { TempoInfo, TempoReporter } from './tempo-info';
import { TestClicks } from './test-clicks';
import { TransportDriver } from './transport-driver';
import type { Waveform } from './waveform';
import type { RecordingHandle } from './recorder';
import type { AudioInput } from './audio-input';

/** The tempo (BPM) before any project is loaded. */
const DEFAULT_BPM = 130;

/** Export tails: at least this long (seconds), at most MAX_TAIL_SEC (before the mixer's latency is added). */
const MIN_TAIL_SEC = 0.5;
const MAX_TAIL_SEC = 30;

/** What a transport that has not been given a project yet plays: nothing. */
const NO_EVENTS: EventSource = { project: null as unknown as Project, clips: [] };

/** The audio engine: a Web Audio mirror of the project, driven by the lookahead transport (see the file comment). */
export class Engine implements EngineApi, EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  readonly residency: SampleResidency;
  readonly offline: boolean;
  readonly transportInfo: TempoInfo;
  readonly params = new ParamRegistry();
  /** The live worklet ports; a new one is told where the song is right away. */
  readonly ports = new PortSet();
  /** Notes of instrument channels for effects that follow a melody (host.notes). */
  readonly noteFeed = new NoteFeedHub();
  /** Inserts, routes, sidechains and delay compensation (engine/mixer-graph.ts). */
  readonly mixer: MixerGraph;
  /** Keeps what cannot sound out of the audio graph (engine/idle-parking.ts); absent offline and when switched off. */
  readonly idle?: IdleParking;

  /** The buses after the master track, the safety limiter and the output visualizer's tap. */
  readonly output: OutputStage;

  private readonly automation: AutomationDriver;
  private readonly outputClock: OutputClock;
  private session: EngineSession = { metronome: false, countInBars: 0 };
  private readonly metronome: Metronome | null;
  private readonly strips = new Map<ChannelId, ChannelStrip>();
  private readonly mirror: ProjectMirror;
  private readonly transport: Transport;
  /** Start, stop, the scheduler clock and the positions read back (engine/transport-driver.ts). */
  private readonly driver: TransportDriver;
  /** What offline renders call instead of the scheduler clock (engine/offline-hooks.ts). */
  private readonly offlineHooks: OfflineHooks;
  private readonly schedulerClock: SchedulerClock;
  private readonly pumpMonitor: PumpMonitor;
  /** The clip launcher: decides what plays on top of the song (see core/launcher). */
  private readonly launcherLink: LauncherLink;
  private readonly samplePreview: SamplePreview;
  private readonly notePreview: NotePreview;
  /** The MIDI effects live keys go through on channels that have them. */
  private readonly liveFx: LiveMidiFx;
  private readonly liveFxListeners = new Set<(output: LiveFxOutput) => void>();
  private readonly testClicks: TestClicks;
  private readonly liveCapture: LiveCapture;
  private readonly liveMeters: LiveMeters;
  private readonly listeners = new Set<() => void>();
  /** Sample files whose waveform is being decoded (one that can't be decoded stays, so redraws don't retry it). */
  private readonly waveformKeysLoading = new Set<string>();
  private faults = 0;
  /** Worklet modules by URL: each is added to the context once. */
  private readonly modules = new Map<string, Promise<void>>();
  private readonly initDone: Promise<void>;
  private disposed = false;
  /** The constructor has run to its end (the mixer reports its compensation while the engine is being built). */
  private built = false;
  private deckHostCache: DeckHost | null = null;

  /** The project as last applied, or null before the first one. */
  private get project(): Project | null {
    return this.mirror.project;
  }

  constructor(
    ctx: BaseAudioContext,
    private readonly opts: EngineOptions,
    offline = false,
    /** Offline renders may leave out the master safety limiter (renders that become clips again). */
    private readonly build: { limiter?: boolean } = {},
  ) {
    this.ctx = ctx;
    this.offline = offline;
    this.plugins = withRackPlugin(opts.plugins);
    this.samples = opts.sampleCache ?? new SampleCache(opts.samples);
    this.residency = this.createResidency();
    this.transportInfo = new TempoInfo(DEFAULT_BPM, ctx);
    this.outputClock = new OutputClock(ctx);
    this.output = new OutputStage(ctx, offline);
    this.mixer = new MixerGraph(
      this,
      this.output.masterOut,
      () => this.emit(),
      () => this.alignChannels(),
    );
    if (!offline && isRealtimeContext(ctx) && opts.idleParking !== false) {
      this.idle = new IdleParking(ctx, this.strips, this.mixer);
      this.idle.start();
    }
    this.transport = this.createTransport();
    this.automation = this.createAutomation();
    this.mirror = this.createProjectMirror();
    this.metronome = offline ? null : this.createMetronome();
    this.observeTransport();
    this.schedulerClock = new SchedulerClock(() => this.driver.tick());
    this.pumpMonitor = new PumpMonitor(ctx);
    this.launcherLink = this.createLauncherLink();
    this.driver = this.createTransportDriver();
    this.offlineHooks = new OfflineHooks({
      ctx,
      transport: this.transport,
      driver: this.driver,
      launcherLink: this.launcherLink,
      residency: this.residency,
      strips: this.strips,
    });
    this.samplePreview = this.createSamplePreview();
    this.liveFx = this.createLiveFx();
    this.notePreview = this.createNotePreview();
    this.testClicks = new TestClicks(ctx, this.output.monitorBus);
    this.liveCapture = this.createLiveCapture();
    this.liveMeters = this.createLiveMeters();
    if (!offline && isRealtimeContext(ctx)) ctx.addEventListener('statechange', () => this.emit());
    this.built = true;
    this.initDone = this.installSafetyLimiter();
  }

  private createResidency(): SampleResidency {
    return new SampleResidency({
      cache: this.samples,
      ctx: this.ctx,
      offline: this.offline,
      onReady: (ids) => {
        for (const id of ids) this.strips.get(id)?.buffersChanged();
      },
      onStretching: () => this.emit(),
    });
  }

  /** The transport starts with nothing to play; the project's events and timeline arrive with `updateModel`. */
  private createTransport(): Transport {
    const transport = new Transport(this.ctx, new SongNoteSink(this.strips, this.noteFeed), NO_EVENTS, {
      tempo: constantTempo(DEFAULT_BPM),
      loop: { start: 0, end: 1 },
      endTick: 1,
    });
    transport.onEnded = () => this.emit();
    this.transportInfo.secondsPerTickAt = (time) => transport.sptAt(time);
    return transport;
  }

  private createAutomation(): AutomationDriver {
    return new AutomationDriver({
      ctx: this.ctx,
      params: this.params,
      offline: this.offline,
      specsOf: (pluginId) => this.plugins.get(pluginId)?.params as ParamSpecs | undefined,
      timeline: () => this.transport.currentTimeline,
    });
  }

  private createProjectMirror(): ProjectMirror {
    return new ProjectMirror({
      core: this,
      strips: this.strips,
      mixer: this.mixer,
      noteFeed: this.noteFeed,
      residency: this.residency,
      automation: this.automation,
      tempo: this.transportInfo,
      view: () => this.driver.view,
      isPlaying: () => this.transport.playing,
      replan: () => this.driver.replan(),
    });
  }

  private createMetronome(): Metronome {
    return new Metronome(
      this.ctx,
      this.output.monitorBus,
      () => (this.project ? { tempo: this.tempoMap(), timeSig: this.project.transport.timeSig } : null),
      () => this.mixer.latency,
    );
  }

  private createSamplePreview(): SamplePreview {
    return new SamplePreview({
      ctx: this.ctx,
      samples: this.samples,
      bus: this.output.previewBus,
      resume: () => this.resume(),
      nextBeatTime: () => this.driver.nextBeatTime(),
    });
  }

  private createNotePreview(): NotePreview {
    return new NotePreview({
      ctx: this.ctx,
      strips: this.strips,
      noteFeed: this.noteFeed,
      clock: this.outputClock,
      midiFx: this.liveFx,
      resume: () => this.resume(),
    });
  }

  /** The live MIDI effects, with the scheduler's worker clock running them ahead of the audio clock (realtime engines only). */
  private createLiveFx(): LiveMidiFx {
    const hasClock = !this.offline && isRealtimeContext(this.ctx);
    return createLiveMidiFx({
      ctx: this.ctx,
      strips: this.strips,
      noteFeed: this.noteFeed,
      project: () => this.project,
      tempoMap: () => this.tempoMap(),
      songTickAt: (time) => (this.transport.playing ? this.driver.tickAt(time).tick : null),
      restingTick: () => this.driver.tickAt(this.ctx.currentTime).tick,
      timer: hasClock ? new SchedulerClock(() => this.liveFx.tick()) : null,
      report: (output) => {
        for (const listener of this.liveFxListeners) listener(output);
      },
    });
  }

  private createLiveMeters(): LiveMeters {
    return new LiveMeters({
      ctx: this.ctx,
      canOpen: () => !this.offline && !this.disposed,
      loadModule: (url) => this.loadModule(url),
      outputNode: (source) => this.mixer.outputNode(source),
    });
  }

  /** What the transport tells while it runs: automation, the metronome, worklet kernels and tempo-synced plugins. */
  private observeTransport(): void {
    this.transport.observe(this.automation);
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
    this.transport.observe(new TempoReporter(this.transportInfo, () => this.project?.transport.bpm ?? null));
  }

  private createLauncherLink(): LauncherLink {
    return new LauncherLink({
      ctx: this.ctx,
      transport: this.transport,
      strips: this.strips,
      residency: this.residency,
      project: () => this.project,
      heardTime: () => this.driver.heardTime(),
      startLead: () => this.outputClock.startLead(),
      replan: () => this.driver.replan(),
      resume: () => this.resume(),
      startTransportForLauncher: () => this.driver.startForLauncher(),
      stop: () => this.stop(),
    });
  }

  private createTransportDriver(): TransportDriver {
    return new TransportDriver({
      ctx: this.ctx,
      offline: this.offline,
      transport: this.transport,
      launcherLink: this.launcherLink,
      outputClock: this.outputClock,
      pumpMonitor: this.pumpMonitor,
      schedulerClock: this.schedulerClock,
      residency: this.residency,
      automation: this.automation,
      mixer: this.mixer,
      strips: this.strips,
      tempoInfo: this.transportInfo,
      metronome: this.metronome,
      project: () => this.project,
      session: () => this.session,
      isDisposed: () => this.disposed,
      emit: () => this.emit(),
      resume: () => this.resume(),
    });
  }

  private createLiveCapture(): LiveCapture {
    return new LiveCapture({
      ctx: this.ctx,
      previewBus: this.output.previewBus,
      resume: () => this.resume(),
      loadModule: (url) => this.loadModule(url),
      insertInput: (id) => this.insertInput(id),
      stop: () => this.stop(),
      hasProject: () => this.project !== null,
      songBpmAt: (tick) => this.tempoMap().bpmAt(tick),
      startPlayAlong: (fromTick, at) => this.driver.startPlayAlong(fromTick, at),
    });
  }

  // ---- Boot and plugin modules ----

  /** Inserts the master safety limiter once its worklet module has loaded (offline renders may leave it out). */
  private async installSafetyLimiter(): Promise<void> {
    if (this.build.limiter === false) return;
    await this.output.installSafetyLimiter((url) => this.loadModule(url));
  }

  /** Adds an AudioWorklet module to the context, once per URL (a failed load may be tried again). */
  loadModule(url: string): Promise<void> {
    let loading = this.modules.get(url);
    if (!loading) {
      loading = this.ctx.audioWorklet.addModule(url);
      this.modules.set(url, loading);
      loading.catch(() => this.modules.delete(url));
    }
    return loading;
  }

  /** Resolves once every worklet processor has handled all messages sent so far (export barrier). */
  async syncWorklets(timeoutMs = 2000): Promise<boolean> {
    const allSynced = Promise.all([...this.ports].map((port) => port.sync())).then(() => true);
    const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return Promise.race([allSynced, timedOut]);
  }

  /** Plugin definitions changed (hot reload, plugin added/removed): rebuild the affected instances. */
  pluginsChanged(ids: readonly string[]): void {
    if (!this.project || ids.length === 0) return;
    const changed = new Set(ids);
    for (const strip of this.strips.values()) if (changed.has(strip.pluginId)) strip.reload(this.project);
    this.mixer.pluginsChanged(changed, this.project);
  }

  /**
   * A realtime engine with its own AudioContext. A bigger `latencyHint` gives the audio thread more
   * room before it runs dry (busy songs play without crackles) at the cost of a later response.
   */
  static realtime(opts: EngineOptions, latencyHint: AudioContextLatencyCategory | number = 'interactive'): Engine {
    return new Engine(new AudioContext({ latencyHint }), opts, false);
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
    if (isRealtimeContext(this.ctx) && this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Resolves when the master chain and every plugin instance have loaded (not the audio clips' samples). */
  async pluginsReady(): Promise<void> {
    await this.initDone;
    await Promise.all([...[...this.strips.values()].map((s) => s.ready), this.mixer.ready]);
  }

  /**
   * Resolves once the length of every sample in a plugin's slot is known (`host.samples.durationSec`), so a plugin's
   * `tailTime` can depend on its samples. Reads file headers (a decode only for a file they don't describe) and skips
   * what the project already records, so it is cheap. The export's tail probe waits for it after `pluginsReady`.
   */
  async sampleLengthsReady(): Promise<void> {
    const project = this.project;
    if (!project) return;
    await Promise.all(
      [...pluginSampleIds(project)].map((id) => {
        const ref = project.samples[id];
        return ref ? this.samples.learnDuration(ref, this.ctx).catch(() => null) : null;
      }),
    );
  }

  /** Resolves when the master chain and every plugin instance (instruments and effects) have loaded. */
  async ready(): Promise<void> {
    await this.initDone;
    await Promise.all([...[...this.strips.values()].map((s) => s.ready), this.mixer.ready, this.residency.settled()]);
  }

  // ---- Document mirroring ----

  applyDocChange(change: DocChange): void {
    this.mirror.applyDocChange(change);
    this.liveFx.projectChanged();
  }

  /** True while a time-stretched copy of the channel's sample is being computed. */
  isStretching(channelId: ChannelId): boolean {
    return this.residency.isStretching(channelId);
  }

  notify(): void {
    this.emit();
  }

  /** Where a channel routed to `id` is held back (seconds): see MixerGraph.shiftSeconds. */
  channelShift(id: InsertId): number {
    return this.mixer.shiftSeconds(id);
  }

  /** The mixer recomputed its delay compensation (it may do so while the engine is still being built). */
  private alignChannels(): void {
    if (!this.built || this.disposed) return;
    this.mirror.alignChannels();
  }

  // ---- What the transport plays ----

  setTransportView(view: TransportView): void {
    this.driver.setView(view);
  }

  /** The tempo map playback uses now (song mode follows tempo automation). */
  tempoMap(): TempoMap {
    return this.driver.tempoMap();
  }

  setSongOpenEnded(on: boolean): void {
    this.driver.setOpenEnded(on);
  }

  // ---- The clip launcher ----

  /** Hands over what decides what the launcher plays (null lets go). The engine reads its runs on every scheduler tick. */
  setLauncher(driver: LaunchDriver | null): void {
    this.launcherLink.setDriver(driver);
  }

  launcherClock(): LaunchClock {
    return this.launcherLink.clock();
  }

  launcherChanged(): void {
    this.launcherLink.runsChanged();
  }

  /**
   * Resolves when what the launcher's runs play is ready: samples decoded and stretched copies made. Presses never wait for
   * it (a pass whose copy is late plays the plain sample first); tests and renders do, to hear what a settled launcher plays.
   */
  launchReady(): Promise<void> {
    return this.launcherLink.ready();
  }

  // ---- EngineCore ----

  /** Where a channel routed to `id` connects (unknown inserts play through the master). */
  insertInput(id: InsertId): OrderedMix {
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
    this.driver.play(fromTick);
  }

  stop(): void {
    this.driver.stop();
    // Stop silences everything, including an arpeggio a key press latched and the echoes of a live note.
    this.liveFx.allNotesOff();
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
    for (const strip of this.strips.values()) strip.allNotesOff(now, true);
    for (const port of this.ports) port.reset();
    this.output.duckForPanic();
  }

  playhead(): number {
    return this.driver.playhead();
  }

  playheadIteration(): number {
    return this.driver.playheadIteration();
  }

  tickAt(contextTime: number): { tick: number; iter: number } {
    return this.driver.tickAt(contextTime);
  }

  contextTimeAt(performanceMs: number): number {
    return this.outputClock.contextTimeAt(performanceMs);
  }

  // ---- Offline rendering ----

  /** Offline rendering: start the transport on the virtual clock (call pumpOffline per chunk). */
  startOffline(fromTick: number, at: number): void {
    this.offlineHooks.start(fromTick, at);
  }

  pumpOffline(horizon: number): void {
    this.offlineHooks.pump(horizon);
  }

  /** Offline rendering: the music ends at `time` (context seconds): notes still held are released there. */
  endOffline(time: number): void {
    this.offlineHooks.end(time);
  }

  /**
   * Offline renders: everything the clips scheduled up to `horizon` (context time) play from is
   * decoded (and stretched) before they are scheduled, so a render never depends on timing.
   */
  prepareOffline(horizon: number): Promise<void> {
    return this.offlineHooks.prepare(horizon);
  }

  /** Offline renders: like prepareOffline, for song ticks [fromTick, toTick] (before the transport starts). */
  prepareTicks(fromTick: number, toTick: number): Promise<void> {
    return this.offlineHooks.prepareTicks(fromTick, toTick);
  }

  // ---- Previews and live notes ----

  previewNoteOn(channelId: ChannelId, key: number, velocity?: number): number {
    return this.notePreview.noteOn(channelId, key, velocity);
  }

  previewNoteOff(channelId: ChannelId, noteId: number): void {
    this.notePreview.noteOff(channelId, noteId);
  }

  previewControl(channelId: ChannelId, cc: number, value: number): void {
    this.notePreview.controlChange(channelId, cc, value);
  }

  previewPitchBend(channelId: ChannelId, cents: number): void {
    this.notePreview.pitchBend(channelId, cents);
  }

  onLiveFxOutput(listener: (output: LiveFxOutput) => void): () => void {
    this.liveFxListeners.add(listener);
    return () => this.liveFxListeners.delete(listener);
  }

  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    this.samplePreview.playSample(ref);
  }

  previewAudio(bytes: ArrayBuffer, opts: PreviewOptions = {}): Promise<boolean> {
    return this.samplePreview.playFile(bytes, opts);
  }

  stopPreview(): void {
    this.samplePreview.stop();
  }

  setPreviewVolume(gain: number): void {
    this.samplePreview.setVolume(gain);
  }

  playTestClicks(count: number, interval: number): number[] {
    return this.testClicks.play(count, interval);
  }

  // ---- Recording ----

  record(stream: MediaStream, opts: RecordAlongOptions): Promise<RecordingHandle> {
    return this.liveCapture.record(stream, opts);
  }

  openAudioInput(stream: MediaStream, opts: { channels: 1 | 2; label?: string; latency?: number }): Promise<AudioInput> {
    return this.liveCapture.openInput(stream, opts);
  }

  // ---- Samples ----

  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null {
    const cached = this.samples.waveform(ref, this.ctx.sampleRate);
    if (cached) return cached;
    const key = SampleCache.keyOf(ref.source, this.ctx.sampleRate);
    if (!this.waveformKeysLoading.has(key)) {
      this.waveformKeysLoading.add(key);
      // A sample that can't be decoded stays in the set: it isn't tried again on every redraw.
      void this.samples.loadWaveform(ref, this.ctx).then((done) => {
        if (!done) return;
        this.waveformKeysLoading.delete(key);
        this.emit();
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

  // ---- Meters and taps ----

  readMeters(order: readonly InsertId[], out: Float32Array): void {
    this.mixer.readMeters(order, out);
  }

  openMeter(source: InsertId, opts: { full?: boolean } = {}): MeterHandle | null {
    return this.liveMeters.openOn(source, opts);
  }

  /** Meters that are open (a closed Meters window leaves none). */
  get meterCount(): number {
    return this.liveMeters.count;
  }

  outputTap(): AudioTap {
    return this.output.outputTap();
  }

  // ---- Automation, session and status ----

  readAutomation(keys: readonly string[], out: Float64Array): void {
    const time = this.driver.heardTime();
    for (let i = 0; i < keys.length && i < out.length; i++) out[i] = this.automation.readValue(keys[i] as string, time);
  }

  touch(key: string, on: boolean): void {
    this.automation.touch(key, on);
  }

  tempoNow(): number {
    return this.transportInfo.tempoAt(this.driver.heardTime());
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

  /** Where the DJ decks join the output (see DeckHost); null for an offline engine. */
  deckHost(): DeckHost | null {
    if (this.offline || !isRealtimeContext(this.ctx)) return null;
    return (this.deckHostCache ??= {
      ctx: this.ctx,
      output: this.output.masterOut,
      loadModule: (url) => this.loadModule(url),
      heardTime: () => this.outputClock.audibleTime(),
    });
  }

  stats(): EngineStats {
    const ctx = this.ctx;
    const realtime = isRealtimeContext(ctx);
    const keepUp = this.pumpMonitor.keepUp;
    return {
      state: this.state,
      sampleRate: ctx.sampleRate,
      baseLatency: realtime ? ctx.baseLatency : 0,
      outputLatency: realtime ? ctx.outputLatency || 0 : 0,
      lookahead: this.transport.lookahead,
      startLead: this.outputClock.startLead(),
      lateEvents: this.transport.lateEvents,
      maxPumpGapMs: Math.round(this.pumpMonitor.maxGapMs),
      faults: this.faults,
      ...(keepUp !== undefined ? { keepUp } : {}),
      ...(this.idle ? { parked: this.idle.counts } : {}),
    };
  }

  /**
   * Seconds of tail to add after the last note when exporting: the longest instrument release plus
   * the effect tails along the deepest route path (capped at 30 s), plus the mixer's latency.
   */
  tailSeconds(): number {
    let tail = MIN_TAIL_SEC;
    for (const strip of this.strips.values()) tail = Math.max(tail, strip.tailTime);
    return Math.min(MAX_TAIL_SEC, tail + this.mixer.tailSeconds()) + this.mixer.latency;
  }

  /** Seconds of the first bar (export/test helper; later bars can differ with tempo automation). */
  barSeconds(): number {
    const project = this.project;
    if (!project) return 0;
    return this.tempoMap().tickToSeconds(ticksPerBar(project.transport.timeSig));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- Shutdown ----

  async dispose(): Promise<void> {
    await this.output.fadeOutIfRunning();
    this.disposed = true;
    this.transport.stop();
    this.liveFx.dispose();
    this.automation.dispose();
    this.metronome?.dispose();
    this.schedulerClock.dispose();
    this.idle?.dispose();
    for (const strip of this.strips.values()) strip.dispose();
    this.strips.clear();
    this.residency.dispose();
    this.mixer.dispose();
    for (const port of [...this.ports]) port.dispose();
    this.liveCapture.closeAll();
    this.output.dispose();
    this.liveMeters.closeAll();
    this.listeners.clear();
    if (isRealtimeContext(this.ctx) && this.ctx.state !== 'closed') await this.ctx.close();
  }

}

/** Every sample a plugin slot (an instrument's or an effect's) refers to. */
function pluginSampleIds(project: Project): Set<SampleId> {
  const ids = new Set<SampleId>();
  const add = (plugin: PluginInstance) => {
    for (const id of Object.values(plugin.samples ?? {})) if (id) ids.add(id);
  };
  for (const channel of Object.values(project.channels)) if (channel.kind === 'instrument') add(channel.plugin);
  for (const insert of Object.values(project.mixer.inserts)) for (const slot of insert.fx) add(slot.plugin);
  return ids;
}
