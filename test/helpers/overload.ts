/**
 * Telling "the code is wrong" from "the machine is too busy" for tests that need a live audio clock.
 *
 * A test of a realtime AudioContext (it must keep up with the wall clock, a loopback recording must land on its beat, a
 * long run must drop no event) fails the same way when the code is slow and when something else on the machine took the
 * cores for a few seconds: the playing user's own audio, another test run, an indexer. The tests run alone in
 * `npm run check` (the `audio-realtime` project), which removes the load the suite makes itself; this covers the rest.
 *
 * `retryWhenOverloaded` runs a measurement and, when it fails, looks at what the machine was doing meanwhile:
 *  - how late the page's own 10 ms timer fired (a stalled main thread is what makes an audio clock appear to stall), and
 *  - how fast a small fixed offline render runs right after, a control that costs the code under test nothing and would run
 *    about a hundred times faster than real time on a quiet machine.
 * A failure with neither signal is a real failure and is thrown at once. A failure on an overloaded machine is run again
 * (a few times); if every attempt was overloaded the test is skipped with the numbers in the message, never failed.
 */
import type { TestContext } from 'vitest';

/** How often the watch's timer asks to run. */
const TIMER_PERIOD_MS = 10;
/** A timer that fires this much later than asked means the page's main thread was stalled (ms). */
const STALL_MS = 250;
/** Seconds of audio the control render makes. */
const CONTROL_SECONDS = 2;
const CONTROL_RATE_HZ = 48000;
/** Oscillators in the control render: enough work that a render takes tens of milliseconds on a quiet machine. */
const CONTROL_VOICES = 32;
/**
 * A control render slower than this many times real time means the machine is overloaded. Quiet, it runs at 100 to 200 times
 * real time here; with nine other Chrome pages rendering it ranged from 2 to 66 from one render to the next, so the best of a
 * few is taken (below) and only a clearly starved machine falls under the limit.
 */
const CONTROL_MIN_SPEED = 25;
/** Control renders taken, the fastest counted: interference only ever slows one down. */
const CONTROL_RENDERS = 3;
/** How many times a failing measurement is run, as long as each failure happened on an overloaded machine. */
const DEFAULT_ATTEMPTS = 3;
/** The pause before a retry, so the load that spoiled an attempt can pass (ms). */
const RETRY_PAUSE_MS = 3000;

/** What the machine was doing while a measurement ran. */
export interface LoadReport {
  /** The latest a 10 ms timer of the page fired, beyond its time (ms). */
  worstTimerLagMs: number;
  /** Seconds of audio per second of wall time for the control render, taken right after. */
  controlSpeed: number;
  /** True when either signal says the machine could not give the test what it needs. */
  overloaded: boolean;
}

/** The speed of one control render: a fixed little graph, offline, in seconds of audio per second of wall time. */
export async function controlRenderSpeed(): Promise<number> {
  const ctx = new OfflineAudioContext(2, CONTROL_SECONDS * CONTROL_RATE_HZ, CONTROL_RATE_HZ);
  const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800, Q: 4 });
  filter.connect(ctx.destination);
  for (let voice = 0; voice < CONTROL_VOICES; voice++) {
    const oscillator = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 55 * (1 + voice * 0.37) });
    oscillator.connect(new GainNode(ctx, { gain: 0.02 })).connect(filter);
    oscillator.start();
  }
  const start = performance.now();
  await ctx.startRendering();
  return CONTROL_SECONDS / ((performance.now() - start) / 1000);
}

/** Watches the page's main thread from `start()` to `stop()`, and then takes the control render. */
export class LoadWatch {
  private worstLagMs = 0;
  private lastTick = performance.now();
  private readonly timer: ReturnType<typeof setInterval>;

  private constructor() {
    this.timer = setInterval(() => {
      const now = performance.now();
      this.worstLagMs = Math.max(this.worstLagMs, now - this.lastTick - TIMER_PERIOD_MS);
      this.lastTick = now;
    }, TIMER_PERIOD_MS);
  }

  /** Starts watching. */
  static start(): LoadWatch {
    return new LoadWatch();
  }

  /** Stops watching without a report (a measurement that passed needs none). */
  discard(): void {
    clearInterval(this.timer);
  }

  /** Stops watching and reports (the control render runs now, while the load that spoiled the attempt is still there). */
  async stop(): Promise<LoadReport> {
    clearInterval(this.timer);
    const worstTimerLagMs = this.worstLagMs;
    let controlSpeed = 0;
    for (let i = 0; i < CONTROL_RENDERS; i++) controlSpeed = Math.max(controlSpeed, await controlRenderSpeed());
    return {
      worstTimerLagMs,
      controlSpeed,
      overloaded: worstTimerLagMs > STALL_MS || controlSpeed < CONTROL_MIN_SPEED,
    };
  }
}

function describeLoad(load: LoadReport): string {
  return `longest timer stall ${Math.round(load.worstTimerLagMs)} ms, control render ${load.controlSpeed.toFixed(0)}x real time`;
}

/** What `retryWhenOverloaded` can be told (the tests of the helper itself replace the watch). */
export interface RetryOptions {
  /** How many times a failing measurement is run while the machine is overloaded (default 3). */
  attempts?: number;
  /** The pause before a retry (ms, default 3000). */
  pauseMs?: number;
  /** Starts watching the machine for one attempt. */
  watchLoad?: () => { stop(): Promise<LoadReport>; discard(): void };
}

/**
 * Runs `measure` (it makes its own engine and cleans up after itself, so it can run again). It passes at once when it
 * resolves. When it throws, the machine's load during the attempt decides: no load, the error is rethrown; load, the
 * attempt is repeated up to `attempts` times, and when every attempt failed under load the test is skipped.
 */
export async function retryWhenOverloaded(
  test: Pick<TestContext, 'skip'>,
  measure: () => Promise<void>,
  { attempts = DEFAULT_ATTEMPTS, pauseMs = RETRY_PAUSE_MS, watchLoad = () => LoadWatch.start() }: RetryOptions = {},
): Promise<void> {
  let lastFailure = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const watch = watchLoad();
    try {
      await measure();
      watch.discard();
      return;
    } catch (error) {
      const load = await watch.stop();
      if (!load.overloaded) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      console.warn(
        `attempt ${attempt} of ${attempts} failed while the machine was overloaded (${describeLoad(load)}): ${lastFailure}`,
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  test.skip(
    `the machine was overloaded in all ${attempts} attempts, so the real-time check could not be made (last failure: ${lastFailure})`,
  );
}
