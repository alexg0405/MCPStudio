/**
 * The warp as a short list of points, for the project file and the overlay on the clip: the lag curve (5 ms frames)
 * thinned to the corners that matter, so a 3-minute clip's warp is a few hundred numbers, not 36,000. Stored flat as
 * `[sampleSec, moveMs, sampleSec, moveMs, …]` (the time on the clip's sample, the move in milliseconds, positive =
 * the sound was moved earlier).
 */

/** The thinned curve may be this far from the real one, milliseconds. */
const TOLERANCE_MS = 1.5;
/** Most points kept (a guard against runaway data in a project file). */
export const MAX_WARP_POINTS = 2000;

/** Drops the points that a straight line between their neighbours explains to within the tolerance (Douglas–Peucker). */
function simplify(times: Float64Array, moves: Float64Array, toleranceMs: number): number[] {
  const keep = new Uint8Array(times.length);
  keep[0] = 1;
  keep[times.length - 1] = 1;
  const stack: [number, number][] = [[0, times.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let worstError = toleranceMs;
    for (let i = a + 1; i < b; i++) {
      const u = ((times[i] as number) - (times[a] as number)) / ((times[b] as number) - (times[a] as number));
      const line = (moves[a] as number) + u * ((moves[b] as number) - (moves[a] as number));
      const error = Math.abs((moves[i] as number) - line);
      if (error > worstError) {
        worstError = error;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) kept.push(i);
  return kept;
}

/**
 * The warp as flat `[sampleSec, moveMs, …]` points: `lagSec` is the lag per frame of `hopSec`, the first frame at
 * `startSec` on the clip's sample. Times are rounded to a millisecond and moves to a tenth of one.
 */
export function warpKnots(lagSec: Float32Array, hopSec: number, startSec: number): number[] {
  if (lagSec.length < 2) return [];
  const times = new Float64Array(lagSec.length);
  const moves = new Float64Array(lagSec.length);
  for (let i = 0; i < lagSec.length; i++) {
    times[i] = startSec + i * hopSec;
    moves[i] = (lagSec[i] as number) * 1000;
  }
  let tolerance = TOLERANCE_MS;
  let indices = simplify(times, moves, tolerance);
  while (indices.length > MAX_WARP_POINTS) {
    tolerance *= 1.5;
    indices = simplify(times, moves, tolerance);
  }
  const flat: number[] = [];
  for (const i of indices) {
    flat.push(Math.round((times[i] as number) * 1000) / 1000, Math.round((moves[i] as number) * 10) / 10);
  }
  return flat;
}

/** The move (milliseconds) at a time on the sample, by a line between the points (0 outside them); `points` is `warpKnots`'s. */
export function moveAt(points: readonly number[], sampleSec: number): number {
  const count = points.length >> 1;
  if (count === 0 || sampleSec < (points[0] as number) || sampleSec > (points[(count - 1) * 2] as number)) return 0;
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((points[mid * 2] as number) <= sampleSec) lo = mid;
    else hi = mid;
  }
  const t0 = points[lo * 2] as number;
  const t1 = points[hi * 2] as number;
  const m0 = points[lo * 2 + 1] as number;
  const m1 = points[hi * 2 + 1] as number;
  return t1 > t0 ? m0 + ((m1 - m0) * (sampleSec - t0)) / (t1 - t0) : m0;
}
