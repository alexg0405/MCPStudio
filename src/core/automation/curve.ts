/**
 * Automation curves: points with a normalized value (0–1) and the shape of the segment that leaves
 * each point. Pure functions shared by the engine (scheduling) and the playlist (drawing).
 */
import type { AutoPoint, Tick } from '../model/types';

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Steps of a 'stairs' segment. */
export const STAIRS_STEPS = 4;

/** Bends progress x (0–1) by tension (−1…1; 0 = straight, > 0 slow start, < 0 fast start). */
export function bend(x: number, tension: number): number {
  if (!tension) return x;
  const c = tension * 6;
  return (Math.exp(c * x) - 1) / (Math.exp(c) - 1);
}

/** The value between point `a` and the next point `b` at `tick`; `a`'s shape and tension decide. */
export function segmentValue(a: AutoPoint, b: AutoPoint, tick: Tick): number {
  const span = b.tick - a.tick;
  if (span <= 0) return b.value;
  const x = clamp01((tick - a.tick) / span);
  const d = b.value - a.value;
  switch (a.shape ?? 'curve') {
    case 'hold':
      return a.value;
    case 'stairs':
      return a.value + (d * Math.floor(x * STAIRS_STEPS)) / STAIRS_STEPS;
    case 'smooth':
      return a.value + d * (0.5 - 0.5 * Math.cos(Math.PI * x));
    case 'curve':
      return a.value + d * bend(x, a.tension ?? 0);
  }
}

/** Index of the last point at or before `tick` (−1 when `tick` is before the first point). */
export function pointBefore(points: readonly AutoPoint[], tick: Tick): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.tick <= tick) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The curve's value at a content tick: before the first point the first point's value, after the
 * last point the last value. null when there are no points.
 */
export function curveAt(points: readonly AutoPoint[], tick: Tick): number | null {
  if (points.length === 0) return null;
  const i = pointBefore(points, tick);
  if (i < 0) return points[0]!.value;
  const a = points[i]!;
  const b = points[i + 1];
  return b ? segmentValue(a, b, tick) : a.value;
}

/**
 * Whether the curve jumps at the boundary between segments (a 'hold' or 'stairs' segment ending
 * on a different value): schedulers place two breakpoints there.
 */
export function stepsAt(a: AutoPoint, b: AutoPoint): boolean {
  const shape = a.shape ?? 'curve';
  return (shape === 'hold' || shape === 'stairs') && a.value !== b.value;
}
