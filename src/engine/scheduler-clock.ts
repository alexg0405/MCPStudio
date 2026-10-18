/** How often the scheduler runs while playing (ms). The transport plans a few tenths of a second ahead, so this is frequent enough. */
const SCHEDULER_INTERVAL_MS = 25;

/**
 * The timer that runs the scheduler while playing. It lives in a worker because the main thread's own timers are
 * throttled in background tabs (and the music would stall); a worker's steady tick is not.
 */
export class SchedulerClock {
  private worker: Worker | null = null;

  /** `onTick` runs on every beat of the clock, on the main thread. */
  constructor(private readonly onTick: () => void) {}

  /** Starts ticking (the worker is made on the first start and kept). */
  start(): void {
    if (!this.worker) {
      this.worker = new Worker(new URL('./sched/clock.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = () => this.onTick();
    }
    this.worker.postMessage({ cmd: 'start', interval: SCHEDULER_INTERVAL_MS });
  }

  /** Stops ticking; the worker stays for the next start. */
  stop(): void {
    this.worker?.postMessage({ cmd: 'stop' });
  }

  /** Ends the worker. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

/** The audio clock's progress is compared with the wall clock over windows of at least this many seconds. */
const KEEP_UP_WINDOW_SEC = 1;

/**
 * How well the scheduler and the audio thread keep up, for `EngineStats`: the longest wait between two scheduler runs
 * and how fast the audio clock advances against the wall clock.
 */
export class PumpMonitor {
  private lastPumpAtMs = 0;
  private longestGapMs = 0;
  /** Where the current keep-up window started: the wall clock (ms) and the audio clock (seconds). */
  private windowStart: { wallMs: number; audioSec: number } | null = null;
  private keepUpValue: number | undefined;

  constructor(private readonly audioClock: { readonly currentTime: number }) {}

  /** The longest wait between two scheduler runs since `resetGap()` (ms). */
  get maxGapMs(): number {
    return this.longestGapMs;
  }

  /**
   * How fast the audio clock advanced against the wall clock over the last window (1 = keeping up; 0.9 = a tenth of
   * the sound dropped out). Undefined until a window has been measured.
   */
  get keepUp(): number | undefined {
    return this.keepUpValue;
  }

  /** Forgets the longest gap (playback starts again). */
  resetGap(): void {
    this.longestGapMs = 0;
  }

  /** The scheduler clock starts: measuring begins afresh (the longest gap is kept until `resetGap()`). */
  clockStarted(): void {
    this.lastPumpAtMs = 0;
    this.windowStart = null;
    this.keepUpValue = undefined;
  }

  /** The scheduler ran at `nowMs` (`performance.now()`); `wasPlaying`: the transport was playing when it did. */
  pumped(nowMs: number, wasPlaying: boolean): void {
    if (wasPlaying && this.lastPumpAtMs > 0) this.longestGapMs = Math.max(this.longestGapMs, nowMs - this.lastPumpAtMs);
    this.lastPumpAtMs = nowMs;
    if (wasPlaying) this.measureKeepUp(nowMs);
  }

  private measureKeepUp(nowMs: number): void {
    const audioSec = this.audioClock.currentTime;
    const start = this.windowStart;
    if (!start) {
      this.windowStart = { wallMs: nowMs, audioSec };
      return;
    }
    const wallSec = (nowMs - start.wallMs) / 1000;
    if (wallSec < KEEP_UP_WINDOW_SEC) return;
    this.keepUpValue = Math.min(1, (audioSec - start.audioSec) / wallSec);
    this.windowStart = { wallMs: nowMs, audioSec };
  }
}
