import { tempoMapOf } from '@core/automation/tempo';
import type { ChannelId, Project, Tick } from '@core/model/types';
import { PPQ, constantTempo, type TempoMap } from '@core/time/ppq';
import type { EngineSession, TransportView } from './api';
import type { AutomationDriver } from './automation/driver';
import type { ChannelStrip } from './channel-strip';
import type { LauncherLink } from './launcher-link';
import type { Metronome } from './metronome';
import type { MixerGraph } from './mixer-graph';
import type { OutputClock } from './output-clock';
import type { SampleResidency } from './sample-residency';
import type { SchedulerClock, PumpMonitor } from './scheduler-clock';
import type { Transport } from './sched/transport';
import type { TempoInfo } from './tempo-info';
import { launcherOnlyModel, planTransportModel, sameView, type TransportModel } from './transport-model';

/** The scheduler's lookahead grows by this factor (to at most MAX_LOOKAHEAD_SEC) each time notes went out late. */
const LOOKAHEAD_GROWTH = 1.5;
const MAX_LOOKAHEAD_SEC = 0.25;

/** Finished voices let go of their buffers at most this often while playing (seconds). */
const VOICE_SWEEP_INTERVAL_SEC = 0.5;
/** After a stop, voices that were still releasing are swept once more after this long (ms). */
const SWEEP_AFTER_STOP_MS = 300;

/** The song's next beat is skipped for the one after when it is closer than this (seconds). */
const MIN_BEAT_LEAD_SEC = 0.02;

/** What the transport driver needs from the engine (everything is the engine's own, handed over once). */
export interface TransportDriverDeps {
  ctx: BaseAudioContext;
  offline: boolean;
  transport: Transport;
  launcherLink: LauncherLink;
  outputClock: OutputClock;
  pumpMonitor: PumpMonitor;
  schedulerClock: SchedulerClock;
  residency: SampleResidency;
  automation: AutomationDriver;
  mixer: MixerGraph;
  strips: ReadonlyMap<ChannelId, ChannelStrip>;
  /** The tempo plugins see: its BPM is the fallback before a project is loaded. */
  tempoInfo: TempoInfo;
  /** Null for an offline engine (it has no clicks). */
  metronome: Metronome | null;
  project(): Project | null;
  session(): EngineSession;
  isDisposed(): boolean;
  emit(): void;
  resume(): Promise<void>;
}

/**
 * Starting, stopping and following the song transport: what it plays (the view and the planned model), the scheduler
 * clock that pumps it, count-in, and the positions the UI and previews read back (playhead, heard time, next beat).
 * The engine delegates its transport methods here; the graph and the plugins are not its business.
 */
export class TransportDriver {
  private currentView: TransportView = { mode: 'pattern', patternId: null, loop: null };
  /** Song mode without a loop region plays past the end (recording) instead of looping. */
  private openEnded = false;
  /** Song mode position the residency plans around while stopped (where playback last started). */
  private songPosition = 0;
  private lastSweepTime = 0;
  /** How many `lateEvents` the lookahead already grew for. */
  private lateEventsSeen = 0;

  constructor(private readonly deps: TransportDriverDeps) {}

  /** What the transport plays: pattern or song mode, and its loop region. */
  get view(): TransportView {
    return this.currentView;
  }

  /** Switches what the transport plays (a no-op when it is the same thing). */
  setView(view: TransportView): void {
    if (sameView(view, this.currentView)) return;
    this.currentView = view;
    const project = this.deps.project();
    if (project) this.deps.automation.update(project, view);
    this.replan();
  }

  /** Song mode without a loop region plays on past the end (audio recording) when on. */
  setOpenEnded(on: boolean): void {
    if (on === this.openEnded) return;
    this.openEnded = on;
    this.replan();
  }

  /** What the transport plays and its timeline, or null before a project is loaded. */
  private model(): TransportModel | null {
    const project = this.deps.project();
    if (!project) return null;
    const launch = this.deps.launcherLink.eventSourceExtras();
    if (this.deps.launcherLink.isAlone) return launcherOnlyModel(project, launch);
    return planTransportModel(project, this.currentView, this.openEnded, launch);
  }

  /** The tempo map playback uses now (song mode follows tempo automation). */
  tempoMap(): TempoMap {
    const project = this.deps.project();
    return project ? tempoMapOf(project, this.currentView.mode) : constantTempo(this.deps.tempoInfo.bpm);
  }

  /** Plans what the transport plays again (the project, the view or the launcher's runs changed). */
  replan(): void {
    const model = this.model();
    if (model) this.deps.transport.setModel(model.source, model.timeline);
    this.updateResidency(true);
  }

  // ---- Start and stop ----

  /** Plays from `fromTick` (a seek when already playing); the start is slightly ahead so the first notes make it in time. */
  play(fromTick: Tick = 0): void {
    const { transport, launcherLink, outputClock, residency, pumpMonitor } = this.deps;
    const project = this.deps.project();
    if (!project) return;
    void this.deps.resume();
    // The launcher alone gives way to the song (its runs go on, over the song).
    launcherLink.songStarted();
    this.replan();
    // Playing again while playing is a seek: what was scheduled is cancelled or released first.
    const lateEventsBefore = transport.lateEvents;
    const startAt = this.deps.ctx.currentTime + outputClock.startLead();
    if (this.currentView.mode === 'song') {
      this.songPosition = fromTick;
      residency.setPosition(fromTick, transport.currentTimeline.loop, true);
    }
    if (transport.playing) {
      transport.seek(fromTick, startAt);
    } else {
      pumpMonitor.resetGap();
      transport.start(fromTick, startAt + this.countInSeconds(fromTick, startAt, project));
    }
    // The first notes went out late (a busy main thread): leave more room next time.
    if (transport.lateEvents > lateEventsBefore) outputClock.learnFromLateStart();
    this.startClock();
    this.deps.emit();
  }

  /** Count-in (record mode): the metronome clicks first, then playback; returns how long that takes (seconds). */
  private countInSeconds(fromTick: Tick, startAt: number, project: Project): number {
    const { metronome } = this.deps;
    const countInBars = this.deps.session().countInBars;
    if (!metronome || countInBars <= 0) return 0;
    return metronome.countIn(startAt, countInBars, this.tempoMap().bpmAt(fromTick), project.transport.timeSig);
  }

  /** The launcher starts the transport on its own (nothing from the song plays). */
  startForLauncher(): void {
    this.deps.pumpMonitor.resetGap();
    this.deps.transport.start(0, this.deps.ctx.currentTime + this.deps.outputClock.startLead());
    this.startClock();
    this.deps.emit();
  }

  /** A recording takes: the song plays from `fromTick` at context time `at` while the input is captured. */
  startPlayAlong(fromTick: Tick, at: number): void {
    this.replan();
    this.deps.transport.start(fromTick, at);
    this.startClock();
    this.deps.emit();
  }

  /** Stops the transport, the launcher's runs and the clock; the residency lets go once the voices have released. */
  stop(): void {
    const { transport, launcherLink } = this.deps;
    transport.stop(0);
    launcherLink.stopped();
    this.stopClock();
    // Stopped: the residency lets its pins go, and the voices' buffers once their release is over.
    this.updateResidency(true);
    if (!this.deps.offline) setTimeout(() => this.updateResidency(true), SWEEP_AFTER_STOP_MS);
    this.deps.emit();
  }

  // ---- Sample residency ----

  /**
   * Tells the residency where the song is (what to keep decoded): the heard position while song
   * mode plays, else where song playback last started. Called on every scheduler tick (cheap: it
   * plans again only when the position moved by a second or the song changed).
   */
  updateResidency(force = false): void {
    if (this.deps.offline || this.deps.isDisposed()) return;
    const { transport, residency, ctx } = this.deps;
    const inSongMode = this.currentView.mode === 'song';
    const playingSong = transport.playing && inSongMode;
    if (playingSong) this.songPosition = transport.positionAt(this.heardTime());
    const loop = inSongMode && !this.openEnded ? transport.currentTimeline.loop : null;
    residency.setPosition(this.songPosition, loop, playingSong);
    // Finished voices let go of their buffers (twice a second is plenty).
    const now = ctx.currentTime;
    if (force || now - this.lastSweepTime > VOICE_SWEEP_INTERVAL_SEC) {
      this.lastSweepTime = now;
      for (const strip of this.deps.strips.values()) strip.sweep();
    }
  }

  // ---- Where the song is ----

  /** The playhead in song ticks, as heard (fractional). */
  playhead(): number {
    return this.deps.transport.positionAt(this.heardTime());
  }

  /** How many times the loop has wrapped, as heard. */
  playheadIteration(): number {
    return this.deps.transport.iterationAt(this.heardTime());
  }

  /**
   * The scheduling time of what is being heard: the audible time minus the mixer's latency (delay
   * compensation holds every path back to the longest one, so music scheduled at t is heard at
   * t + graphLatency).
   */
  heardTime(): number {
    return this.deps.outputClock.audibleTime() - this.deps.mixer.latency;
  }

  /** The tick (and loop iteration) that is heard at context time `contextTime`. */
  tickAt(contextTime: number): { tick: number; iter: number } {
    // What is heard at t was scheduled at t − latency (delay compensation holds the music back).
    return this.deps.transport.tickAt(contextTime - this.deps.mixer.latency);
  }

  /**
   * The context time of the song's next beat as it will be heard, or null while it does not play (or the beat is
   * too close to catch). The song's own audio is heard `audibleTime` minus the mixer's latency after it was scheduled,
   * and a source started at context time t is heard at t: so the beat is at `audibleTime + ticks until it`.
   */
  nextBeatTime(): number | null {
    const { transport, outputClock, ctx } = this.deps;
    if (!transport.playing) return null;
    const { tick } = transport.tickAt(this.heardTime());
    const tempo = this.tempoMap();
    const nextTick = (Math.floor(tick / PPQ) + 1) * PPQ;
    const wait = (nextTick - tick) * tempo.secondsPerTick(tick);
    if (!Number.isFinite(wait) || wait < 0) return null;
    let at = outputClock.audibleTime() + wait;
    // Too late to catch this beat: the one after.
    if (at < ctx.currentTime + MIN_BEAT_LEAD_SEC) at += PPQ * tempo.secondsPerTick(nextTick);
    return at;
  }

  // ---- The scheduler clock ----

  private startClock(): void {
    if (this.deps.offline) return;
    this.deps.pumpMonitor.clockStarted();
    this.deps.schedulerClock.start();
  }

  private stopClock(): void {
    this.deps.schedulerClock.stop();
  }

  /** One beat of the scheduler clock: plans what plays in the next few tenths of a second. */
  tick(): void {
    const { transport, pumpMonitor, launcherLink } = this.deps;
    const wasPlaying = transport.playing;
    pumpMonitor.pumped(performance.now(), wasPlaying);
    launcherLink.sync();
    transport.pump();
    this.updateResidency();
    this.raiseLookaheadIfLate();
    if (wasPlaying && !transport.playing) {
      this.stopClock();
      this.deps.emit();
    }
  }

  /** Raises the lookahead when notes arrive late (main-thread jank). */
  private raiseLookaheadIfLate(): void {
    const { transport } = this.deps;
    if (transport.lateEvents <= this.lateEventsSeen) return;
    this.lateEventsSeen = transport.lateEvents;
    transport.lookahead = Math.min(MAX_LOOKAHEAD_SEC, transport.lookahead * LOOKAHEAD_GROWTH);
  }
}
