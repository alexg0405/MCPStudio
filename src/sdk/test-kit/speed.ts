/**
 * Speed tests. A busy machine (parallel workers, other programs) makes the wall clock mostly measure
 * how long the process waited for a core, so a kernel-cost or render-speed assertion should use CPU
 * time and the best of a few attempts: interference only ever adds time, and a quiet machine pays
 * for a single attempt.
 */

/** Microseconds in a millisecond (`process.cpuUsage` reports microseconds). */
const MICROSECONDS_PER_MS = 1000;

/** CPU time spent by this process so far, in ms (wall-clock `performance.now()` where the runtime has no CPU clock). */
export function cpuNow(): number {
  const proc = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } }).process;
  if (typeof proc?.cpuUsage === 'function') {
    const u = proc.cpuUsage();
    return (u.user + u.system) / MICROSECONDS_PER_MS;
  }
  return performance.now();
}

/**
 * The least CPU time (ms) any of `repeats` runs of `run` took. For the cost of audio code: a busy machine interrupts a long run
 * again and again (every interruption leaves the caches cold, so even CPU time grows), while a short run often fits between
 * two interruptions and shows what the code costs when it is left alone, which is what an audio thread gets. Make `run`
 * a few hundred milliseconds of audio at most and `repeats` a hundred or more.
 */
export function cheapestRun(run: () => void, repeats: number): number {
  let least = Infinity;
  for (let i = 0; i < repeats; i++) {
    const start = cpuNow();
    run();
    least = Math.min(least, cpuNow() - start);
  }
  return least;
}

/** How a measurement compares: a duration is better lower, a speed or a throughput factor is better higher. */
export type Better = 'lower' | 'higher';

/**
 * Measure up to `attempts` times and return the best value, stopping at the first attempt whose best-so-far
 * satisfies `pass`. The caller asserts on the result as usual, so a real regression (every attempt slow)
 * still fails.
 */
export async function settle(
  measure: () => number | Promise<number>,
  pass: (best: number) => boolean,
  { attempts = 4, better = 'lower' }: { attempts?: number; better?: Better } = {},
): Promise<number> {
  let best = better === 'lower' ? Infinity : -Infinity;
  for (let i = 0; i < attempts; i++) {
    const v = await measure();
    best = better === 'lower' ? Math.min(best, v) : Math.max(best, v);
    if (pass(best)) break;
  }
  return best;
}
