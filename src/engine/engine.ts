/**
 * The audio engine: owns the AudioContext (or an OfflineAudioContext for export), mirrors the
 * project document into a Web Audio graph and drives the lookahead transport.
 *
 * The engine is the facade the app talks to (`EngineApi`). The work is split between collaborators that each have
 * one job: the mixer graph (`MixerGraph`), the channel strips (`ChannelStrip`), the transport and its scheduler
 * clock (`Transport`, `SchedulerClock`), the clip launcher link, previews, recording and the metering suite.
 */
import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, PluginInstance, PluginOwner, Project, SampleId, SampleRef, Tick } from '@core/model/types';
import { tempoMapOf } from '@core/automation/tempo';
import { PPQ, constantTempo, ticksPerBar, type TempoMap } from '@core/time/ppq';
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
import { KernelTransportFeed } from './kernel-transport';
import { LauncherLink } from './launcher-link';
import { LIMITER_ID } from './limiter-id';
import { LiveCapture, type RecordAlongOptions } from './live-capture';
import { LiveMeters } from './live-meters';
import { Metronome } from './metronome';
import { MixerGraph } from './mixer-graph';
import { NoteFeedHub } from './note-feed';
import { NotePreview } from './note-preview';
import { OutputClock } from './output-clock';
import { ParamRegistry } from './param-lane';
import { PortSet } from './port-set';
import { ProjectMirror } from './project-mirror';
import { isRealtimeContext } from './realtime-context';
import { SampleResidency } from './sample-residency';
import { DEFAULT_PREVIEW_VOLUME, SamplePreview } from './sample-preview';
import { SampleCache } from './samples';
import { SchedulerClock, PumpMonitor } from './scheduler-clock';
import type { EventSource } from './sched/events';
import { Transport } from './sched/transport';
import { SongNoteSink } from './song-note-sink';
import { TempoInfo, TempoReporter } from './tempo-info';
import { TestClicks } from './test-clicks';
import { launcherOnlyModel, planTransportModel, sameView, type TransportModel } from './transport-model';
import { INACTIVE_TAP, TapImpl } from './tap';
import type { Waveform } from './waveform';
import type { RecordingHandle } from './recorder';
import type { AudioInput } from './audio-input';
import limiterUrl from './limiter.worklet.ts?worker&url';

/** The tempo (BPM) before any project is loaded. */
const DEFAULT_BPM = 130;

/** Level of the monitor bus (metronome and count-in clicks), a linear gain. */
const MONITOR_BUS_GAIN = 0.9;

/** Seconds a replaced engine takes to fade out. */
const DISPOSE_FADE_SEC = 0.012;
/** Extra milliseconds waited after the fade, so the ramp has certainly finished. */
const DISPOSE_FADE_SLACK_MS = 3;

/** The scheduler's lookahead grows by this factor (to at most MAX_LOOKAHEAD_SEC) each time notes went out late. */
const LOOKAHEAD_GROWTH = 1.5;
const MAX_LOOKAHEAD_SEC = 0.25;

/** Finished voices let go of their buffers at most this often while playing (seconds). */
const VOICE_SWEEP_INTERVAL_SEC = 0.5;
/** After a stop, voices that were still releasing are swept once more after this long (ms). */
const SWEEP_AFTER_STOP_MS = 300;

/**
 * Panic ducks the output over this long (seconds), holds it silent until PANIC_SILENT_UNTIL_SEC (long enough for
 * ringing tails to die), and is back at full level at PANIC_FULL_AT_SEC. All counted from the call.
 */
const PANIC_DUCK_SEC = 0.01;
const PANIC_SILENT_UNTIL_SEC = 0.6;
const PANIC_FULL_AT_SEC = 0.65;

/** The song's next beat is skipped for the one after when it is closer than this (seconds). */
const MIN_BEAT_LEAD_SEC = 0.02;

/** Export tails: at least this long (seconds), at most MAX_TAIL_SEC (before the mixer's latency is added). */
const MIN_TAIL_SEC = 0.5;
const MAX_TAIL_SEC = 30;

/** The output visualizer's FFT size and smoothing (0 to 1). */
const OUTPUT_TAP_OPTIONS = { fftSize: 4096, smoothing: 0.8 };

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

  private readonly automation: AutomationDriver;
  private readonly outputClock: OutputClock;
  private session: EngineSession = { metronome: false, countInBars: 0 };
  /** Post-master bus: master insert + previews → safety limiter → destination. */
  private readonly masterOut: GainNode;
  private readonly previewBus: GainNode;
  /** Metronome and count-in clicks: after the master track, before the limiter; never exported. */
  private readonly monitorBus: GainNode;
  private readonly metronome: Metronome | null;
  private readonly strips = new Map<ChannelId, ChannelStrip>();
  private readonly mirror: ProjectMirror;
  private view: TransportView = { mode: 'pattern', patternId: null, loop: null };
  private readonly transport: Transport;
  private readonly schedulerClock: SchedulerClock;
  private readonly pumpMonitor: PumpMonitor;
  /** The clip launcher: decides what plays on top of the song (see core/launcher). */
  private readonly launcherLink: LauncherLink;
  private readonly samplePreview: SamplePreview;
  private readonly notePreview: NotePreview;
  private readonly testClicks: TestClicks;
  private readonly liveCapture: LiveCapture;
  private readonly liveMeters: LiveMeters;
  private readonly listeners = new Set<() => void>();
  /** Sample files whose waveform is being decoded (one that can't be decoded stays, so redraws don't retry it). */
  private readonly waveformKeysLoading = new Set<string>();
  private faults = 0;
  /** How many `lateEvents` the lookahead already grew for. */
  private lateEventsSeen = 0;
  /** Worklet modules by URL: each is added to the context once. */
  private readonly modules = new Map<string, Promise<void>>();
  private readonly initDone: Promise<void>;
  private limiter: AudioWorkletNode | null = null;
  /** Song mode without a loop region plays past the end (recording) instead of looping. */
  private openEnded = false;
  /** Song mode position the residency plans around while stopped (where playback last started). */
  private songPosition = 0;
  private lastSweepTime = 0;
  private disposed = false;
  /** The constructor has run to its end (the mixer reports its compensation while the engine is being built). */
  private built = false;
  private outputTapCache: TapImpl | null = null;
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
    this.plugins = opts.plugins;
    this.samples = opts.sampleCache ?? new SampleCache(opts.samples);
    this.residency = this.createResidency();
    this.transportInfo = new TempoInfo(DEFAULT_BPM, ctx);
    this.outputClock = new OutputClock(ctx);
    this.masterOut = new GainNode(ctx);
    this.previewBus = new GainNode(ctx, { gain: DEFAULT_PREVIEW_VOLUME });
    this.monitorBus = new GainNode(ctx, { gain: MONITOR_BUS_GAIN });
    this.masterOut.connect(ctx.destination);
    this.previewBus.connect(this.masterOut);
    this.monitorBus.connect(this.masterOut);
    this.mixer = new MixerGraph(
      this,
      this.masterOut,
      () => this.emit(),
      () => this.alignChannels(),
    );
    this.transport = this.createTransport();
    this.automation = this.createAutomation();
    this.mirror = this.createProjectMirror();
    this.metronome = offline ? null : this.createMetronome();
    this.observeTransport();
    this.schedulerClock = new SchedulerClock(() => this.tick());
    this.pumpMonitor = new PumpMonitor(ctx);
    this.launcherLink = this.createLauncherLink();
    this.samplePreview = this.createSamplePreview();
    this.notePreview = this.createNotePreview();
    this.testClicks = new TestClicks(ctx, this.monitorBus);
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
      view: () => this.view,
      isPlaying: () => this.transport.playing,
      replan: () => this.updateModel(),
    });
  }

  private createMetronome(): Metronome {
    return new Metronome(
      this.ctx,
      this.monitorBus,
      () => (this.project ? { tempo: this.tempoMap(), timeSig: this.project.transport.timeSig } : null),
      () => this.mixer.latency,
    );
  }

  private createSamplePreview(): SamplePreview {
    return new SamplePreview({
      ctx: this.ctx,
      samples: this.samples,
      bus: this.previewBus,
      resume: () => this.resume(),
      nextBeatTime: () => this.nextBeatTime(),
    });
  }

  private createNotePreview(): NotePreview {
    return new NotePreview({
      ctx: this.ctx,
      strips: this.strips,
      noteFeed: this.noteFeed,
      clock: this.outputClock,
      resume: () => this.resume(),
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
      heardTime: () => this.heardTime(),
      startLead: () => this.outputClock.startLead(),
      replan: () => this.updateModel(),
      resume: () => this.resume(),
      startTransportForLauncher: () => {
        this.pumpMonitor.resetGap();
        this.transport.start(0, this.ctx.currentTime + this.outputClock.startLead());
        this.startClock();
        this.emit();
      },
      stop: () => this.stop(),
    });
  }

  private createLiveCapture(): LiveCapture {
    return new LiveCapture({
      ctx: this.ctx,
      previewBus: this.previewBus,
      resume: () => this.resume(),
      loadModule: (url) => this.loadModule(url),
      insertInput: (id) => this.insertInput(id),
      stop: () => this.stop(),
      hasProject: () => this.project !== null,
      songBpmAt: (tick) => this.tempoMap().bpmAt(tick),
      startPlayAlong: (fromTick, at) => {
        this.updateModel();
        this.transport.start(fromTick, at);
        this.startClock();
        this.emit();
      },
    });
  }

  // ---- Boot and plugin modules ----

  /** Inserts the master safety limiter once its worklet module has loaded. */
  private async installSafetyLimiter(): Promise<void> {
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
    if (sameView(view, this.view)) return;
    this.view = view;
    if (this.project) this.automation.update(this.project, view);
    this.updateModel();
  }

  /** What the transport plays and its timeline, or null before a project is loaded. */
  private model(): TransportModel | null {
    const project = this.project;
    if (!project) return null;
    const launch = this.launcherLink.eventSourceExtras();
    if (this.launcherLink.isAlone) return launcherOnlyModel(project, launch);
    return planTransportModel(project, this.view, this.openEnded, launch);
  }

  /** The tempo map playback uses now (song mode follows tempo automation). */
  tempoMap(): TempoMap {
    return this.project ? tempoMapOf(this.project, this.view.mode) : constantTempo(this.transportInfo.bpm);
  }

  /** Plans what the transport plays again (the project, the view or the launcher's runs changed). */
  private updateModel(): void {
    const model = this.model();
    if (model) this.transport.setModel(model.source, model.timeline);
    this.updateResidency(true);
  }

  setSongOpenEnded(on: boolean): void {
    if (on === this.openEnded) return;
    this.openEnded = on;
    this.updateModel();
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

  // ---- Sample residency ----

  /**
   * Tells the residency where the song is (what to keep decoded): the heard position while song
   * mode plays, else where song playback last started. Called on every scheduler tick (cheap: it
   * plans again only when the position moved by a second or the song changed).
   */
  private updateResidency(force = false): void {
    if (this.offline || this.disposed) return;
    const playingSong = this.transport.playing && this.view.mode === 'song';
    if (playingSong) this.songPosition = this.transport.positionAt(this.heardTime());
    const loop = this.view.mode === 'song' && !this.openEnded ? this.transport.currentTimeline.loop : null;
    this.residency.setPosition(this.songPosition, loop, playingSong);
    // Finished voices let go of their buffers (twice a second is plenty).
    const now = this.ctx.currentTime;
    if (force || now - this.lastSweepTime > VOICE_SWEEP_INTERVAL_SEC) {
      this.lastSweepTime = now;
      for (const strip of this.strips.values()) strip.sweep();
    }
  }

  /**
   * Offline renders: everything the clips scheduled up to `horizon` (context time) play from is
   * decoded (and stretched) before they are scheduled, so a render never depends on timing.
   */
  async prepareOffline(horizon: number): Promise<void> {
    // Finished voices let go of their buffers (so what the render has passed can be evicted).
    for (const strip of this.strips.values()) strip.sweep();
    if (this.view.mode !== 'song') return;
    const fromTick = this.transport.tickAt(this.ctx.currentTime).tick;
    const toTick = this.transport.tickAt(horizon).tick;
    await this.residency.ensure(fromTick, toTick);
  }

  /** Offline renders: like prepareOffline, for song ticks [fromTick, toTick] (before the transport starts). */
  async prepareTicks(fromTick: number, toTick: number): Promise<void> {
    if (this.view.mode !== 'song') return;
    await this.residency.ensure(fromTick, toTick);
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
    if (!this.project) return;
    void this.resume();
    // The launcher alone gives way to the song (its runs go on, over the song).
    this.launcherLink.songStarted();
    this.updateModel();
    // Playing again while playing is a seek: what was scheduled is cancelled or released first.
    const lateEventsBefore = this.transport.lateEvents;
    const startAt = this.ctx.currentTime + this.outputClock.startLead();
    if (this.view.mode === 'song') {
      this.songPosition = fromTick;
      this.residency.setPosition(fromTick, this.transport.currentTimeline.loop, true);
    }
    if (this.transport.playing) {
      this.transport.seek(fromTick, startAt);
    } else {
      this.pumpMonitor.resetGap();
      this.transport.start(fromTick, startAt + this.countInSeconds(fromTick, startAt, this.project));
    }
    // The first notes went out late (a busy main thread): leave more room next time.
    if (this.transport.lateEvents > lateEventsBefore) this.outputClock.learnFromLateStart();
    this.startClock();
    this.emit();
  }

  /** Count-in (record mode): the metronome clicks first, then playback; returns how long that takes (seconds). */
  private countInSeconds(fromTick: Tick, startAt: number, project: Project): number {
    if (!this.metronome || this.session.countInBars <= 0) return 0;
    return this.metronome.countIn(startAt, this.session.countInBars, this.tempoMap().bpmAt(fromTick), project.transport.timeSig);
  }

  stop(): void {
    this.transport.stop(0);
    this.launcherLink.stopped();
    this.stopClock();
    // Stopped: the residency lets its pins go, and the voices' buffers once their release is over.
    this.updateResidency(true);
    if (!this.offline) setTimeout(() => this.updateResidency(true), SWEEP_AFTER_STOP_MS);
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
    for (const strip of this.strips.values()) strip.allNotesOff(now, true);
    for (const port of this.ports) port.reset();
    // Graph effects can't be flushed: duck the output while their tails ring out.
    const gain = this.masterOut.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + PANIC_DUCK_SEC);
    gain.setValueAtTime(0, now + PANIC_SILENT_UNTIL_SEC);
    gain.linearRampToValueAtTime(1, now + PANIC_FULL_AT_SEC);
  }

  /** Offline rendering: start the transport on the virtual clock (call pumpOffline per chunk). */
  startOffline(fromTick: number, at: number): void {
    this.updateModel();
    this.transport.start(fromTick, at);
  }

  pumpOffline(horizon: number): void {
    this.launcherLink.sync();
    this.transport.pump(horizon);
  }

  /** Offline rendering: the music ends at `time` (context seconds): notes still held are released there. */
  endOffline(time: number): void {
    this.transport.releaseHeld(time);
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
    return this.outputClock.audibleTime() - this.mixer.latency;
  }

  tickAt(contextTime: number): { tick: number; iter: number } {
    // What is heard at t was scheduled at t − latency (delay compensation holds the music back).
    return this.transport.tickAt(contextTime - this.mixer.latency);
  }

  contextTimeAt(performanceMs: number): number {
    return this.outputClock.contextTimeAt(performanceMs);
  }

  /**
   * The context time of the song's next beat as it will be heard, or null while it does not play (or the beat is
   * too close to catch). The song's own audio is heard `audibleTime` minus the mixer's latency after it was scheduled,
   * and a source started at context time t is heard at t: so the beat is at `audibleTime + ticks until it`.
   */
  private nextBeatTime(): number | null {
    if (!this.transport.playing) return null;
    const { tick } = this.transport.tickAt(this.heardTime());
    const tempo = this.tempoMap();
    const nextTick = (Math.floor(tick / PPQ) + 1) * PPQ;
    const wait = (nextTick - tick) * tempo.secondsPerTick(tick);
    if (!Number.isFinite(wait) || wait < 0) return null;
    let at = this.outputClock.audibleTime() + wait;
    // Too late to catch this beat: the one after.
    if (at < this.ctx.currentTime + MIN_BEAT_LEAD_SEC) at += PPQ * tempo.secondsPerTick(nextTick);
    return at;
  }

  // ---- The scheduler clock ----

  private startClock(): void {
    if (this.offline) return;
    this.pumpMonitor.clockStarted();
    this.schedulerClock.start();
  }

  private stopClock(): void {
    this.schedulerClock.stop();
  }

  /** One beat of the scheduler clock: plans what plays in the next few tenths of a second. */
  private tick(): void {
    const wasPlaying = this.transport.playing;
    this.pumpMonitor.pumped(performance.now(), wasPlaying);
    this.launcherLink.sync();
    this.transport.pump();
    this.updateResidency();
    this.raiseLookaheadIfLate();
    if (wasPlaying && !this.transport.playing) {
      this.stopClock();
      this.emit();
    }
  }

  /** Raises the lookahead when notes arrive late (main-thread jank). */
  private raiseLookaheadIfLate(): void {
    if (this.transport.lateEvents <= this.lateEventsSeen) return;
    this.lateEventsSeen = this.transport.lateEvents;
    this.transport.lookahead = Math.min(MAX_LOOKAHEAD_SEC, this.transport.lookahead * LOOKAHEAD_GROWTH);
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
    if (this.offline) return INACTIVE_TAP;
    return (this.outputTapCache ??= new TapImpl(this.ctx, this.masterOut, OUTPUT_TAP_OPTIONS));
  }

  // ---- Automation, session and status ----

  readAutomation(keys: readonly string[], out: Float64Array): void {
    const time = this.heardTime();
    for (let i = 0; i < keys.length && i < out.length; i++) out[i] = this.automation.readValue(keys[i] as string, time);
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

  /** Where the DJ decks join the output (see DeckHost); null for an offline engine. */
  deckHost(): DeckHost | null {
    if (this.offline || !isRealtimeContext(this.ctx)) return null;
    return (this.deckHostCache ??= {
      ctx: this.ctx,
      output: this.masterOut,
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
    await this.fadeOutIfRunning();
    this.disposed = true;
    this.transport.stop();
    this.automation.dispose();
    this.metronome?.dispose();
    this.schedulerClock.dispose();
    for (const strip of this.strips.values()) strip.dispose();
    this.strips.clear();
    this.residency.dispose();
    this.mixer.dispose();
    for (const port of [...this.ports]) port.dispose();
    this.liveCapture.closeAll();
    this.limiter?.port.postMessage({ t: 'dispose' });
    this.liveMeters.closeAll();
    this.outputTapCache?.dispose();
    this.listeners.clear();
    if (isRealtimeContext(this.ctx) && this.ctx.state !== 'closed') await this.ctx.close();
  }

  /** A running engine that is replaced (a new buffer size, a rebooted output) fades out first instead of clicking. */
  private async fadeOutIfRunning(): Promise<void> {
    const ctx = this.ctx;
    if (this.offline || !isRealtimeContext(ctx) || ctx.state !== 'running') return;
    const gain = this.masterOut.gain;
    const now = ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + DISPOSE_FADE_SEC);
    // A hidden tab's timers are throttled: don't wait for them (the context is closed right after anyway).
    if (typeof document !== 'undefined' && document.hidden) return;
    await new Promise((resolve) => setTimeout(resolve, DISPOSE_FADE_SEC * 1000 + DISPOSE_FADE_SLACK_MS));
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
