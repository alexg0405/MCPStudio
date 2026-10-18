import { tempoMapOf } from '@core/automation/tempo';
import { LAUNCH_GRACE_SEC, type LaunchClock, type LaunchDriver, type LaunchRun } from '@core/launcher/run';
import type { ChannelId, Project } from '@core/model/types';
import { constantTempo } from '@core/time/ppq';
import type { ChannelStrip } from './channel-strip';
import type { SampleResidency } from './sample-residency';
import { passClip } from './sched/launch';
import type { EventSource } from './sched/events';
import type { Transport } from './sched/transport';
import { roundBpm } from './tempo-info';

/** The shortest time (seconds) the first notes of a launch need to reach the audio thread. */
const MIN_LAUNCH_LEAD_SEC = 0.015;

/** What the launcher link needs from the engine. */
export interface LauncherLinkHost {
  readonly ctx: BaseAudioContext;
  readonly transport: Transport;
  readonly strips: ReadonlyMap<ChannelId, ChannelStrip>;
  readonly residency: SampleResidency;
  project(): Project | null;
  /** The scheduling time of what is heard now (see Engine.heardTime). */
  heardTime(): number;
  /** Seconds between asking for a start and the first beat (see OutputClock.startLead). */
  startLead(): number;
  /** Plans what the transport plays again (the launcher's runs are part of it). */
  replan(): void;
  /** Starts the context if the browser's autoplay policy left it suspended. */
  resume(): Promise<void>;
  /** Starts the transport at tick 0 for the launcher alone, and the scheduler clock with it. */
  startTransportForLauncher(): void;
  /** Stops everything (the launcher alone ends with its last run). */
  stop(): void;
}

/**
 * The clip launcher on the engine's side: decides nothing about what plays (the driver, see core/launcher, does), but
 * hands the driver's runs to the transport, tells the driver where the transport is, and starts the transport for the
 * launcher alone when the song is not playing.
 */
export class LauncherLink {
  private driver: LaunchDriver | null = null;
  /** The runs the transport was last given: a different array means the driver changed them. */
  private runsSeen: readonly LaunchRun[] | null = null;
  /** The launcher plays on its own (the song is not playing): the transport runs for it alone. */
  private playingAlone = false;

  constructor(private readonly host: LauncherLinkHost) {}

  /** The launcher plays on its own (the transport runs for it, with no song). */
  get isAlone(): boolean {
    return this.playingAlone;
  }

  /** The launcher's runs for the transport's event source (nothing without a driver). */
  eventSourceExtras(): Pick<EventSource, 'launch'> {
    return this.driver ? { launch: { runs: this.driver.runs } } : {};
  }

  /** Hands over what decides what the launcher plays (null lets go). Its runs are read on every scheduler tick. */
  setDriver(driver: LaunchDriver | null): void {
    this.driver = driver;
    this.runsSeen = driver ? driver.runs : null;
    if (!driver) this.playingAlone = false;
    this.host.replan();
  }

  /**
   * Where the transport is on the launcher axis: what is heard now, the earliest tick a launch can still be
   * scheduled at (after the time the first notes need to reach the audio thread) and the earliest boundary one
   * may still take, late (the grace rule: `LAUNCH_GRACE_SEC`). Not playing: all zero.
   */
  clock(): LaunchClock {
    const { transport, ctx } = this.host;
    if (!transport.playing) return { playing: false, heardU: 0, earliestU: 0 };
    const now = ctx.currentTime;
    return {
      playing: true,
      heardU: transport.uAtTime(this.host.heardTime()),
      earliestU: transport.uAtTime(now + Math.max(MIN_LAUNCH_LEAD_SEC, this.host.startLead())),
      lateU: transport.uAtTime(now - LAUNCH_GRACE_SEC),
    };
  }

  /**
   * The driver's runs changed (a press): plays them. While nothing plays, the transport starts for the launcher
   * alone, from tick 0 with the first run starting right there.
   */
  runsChanged(): void {
    const driver = this.driver;
    if (!driver || !this.host.project()) return;
    if (this.host.transport.playing) {
      this.sync();
      return;
    }
    if (driver.runs.length === 0) return;
    this.playingAlone = true;
    this.runsSeen = driver.runs;
    void this.host.resume();
    this.warmAudio(driver.runs);
    this.host.replan();
    this.host.startTransportForLauncher();
  }

  /** Follow actions, ended runs; new runs are planned. Called on every scheduler tick. */
  sync(): void {
    const driver = this.driver;
    if (!driver || !this.host.transport.playing) return;
    const clock = this.clock();
    driver.advance(clock);
    if (driver.runs !== this.runsSeen) {
      this.runsSeen = driver.runs;
      this.warmAudio(driver.runs);
      this.host.replan();
    }
    // The launcher alone stops with its last run.
    if (this.playingAlone && driver.runs.length > 0 && driver.idleAt(clock.heardU)) this.host.stop();
  }

  /** The song starts: the launcher no longer plays alone (its runs go on, over the song). */
  songStarted(): void {
    this.playingAlone = false;
  }

  /** The transport stopped: every run is over and what they kept ready is let go. */
  stopped(): void {
    this.playingAlone = false;
    this.driver?.reset?.();
    this.runsSeen = this.driver ? this.driver.runs : null;
    this.host.residency.endLaunch(new Set());
  }

  /**
   * Resolves when what the launcher's runs play is ready: samples decoded and stretched copies made. Presses never wait for
   * it (a pass whose copy is late plays the plain sample first); tests and renders do, to hear what a settled launcher plays.
   */
  async ready(): Promise<void> {
    if (this.driver) this.warmAudio(this.driver.runs);
    await this.host.residency.settled();
  }

  /**
   * Audio runs: their samples are decoded before the first pass (the playlist's residency does not know them), and on
   * a 'stretch' channel the stretched copy the playlist would play for the first pass is made too, under the tempo the
   * pass starts at (later passes under another tempo make theirs when they come up).
   */
  private warmAudio(runs: readonly LaunchRun[]): void {
    const project = this.host.project();
    const alive = new Set<string>();
    for (const run of runs) {
      if (run.content.kind !== 'audio' || run.passLength <= 0) continue;
      const strip = this.host.strips.get(run.content.channelId);
      if (!strip || !project) continue;
      alive.add(run.id);
      const clip = passClip(run, run.startU, run.passLength);
      strip.warm({ clip, tempo: this.firstPassTempo(run, project) });
    }
    this.host.residency.endLaunch(alive);
  }

  /** The tempo map a run's first pass plays under: the transport's plan while playing, else the project's tempo. */
  private firstPassTempo(run: LaunchRun, project: Project) {
    if (this.host.transport.playing) return this.host.transport.launchTempo(run.startU, run.startU + run.passLength);
    return constantTempo(roundBpm(tempoMapOf(project, 'pattern').bpm));
  }
}
