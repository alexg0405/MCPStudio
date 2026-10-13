/**
 * Curves made by tools rather than by hand: LFO shapes, and recorded knob moves thinned to a few
 * points (Ramer–Douglas–Peucker).
 */
import type { AutoPoint, Tick } from '../model/types';
import { curveAt } from './curve';

export type LfoShape = 'sine' | 'triangle' | 'saw' | 'square' | 'random';
export const LFO_SHAPES: readonly LfoShape[] = ['sine', 'triangle', 'saw', 'square', 'random'];

export interface LfoOptions {
  shape: LfoShape;
  /** Ticks per cycle (e.g. 960 = one beat). */
  period: Tick;
  /** Peak-to-peak size, 0–1 of the target's range. */
  depth: number;
  /** The middle of the wave, 0–1. */
  center: number;
  /** Where in its cycle the wave starts, 0–1. */
  phase: number;
  /** Random steps repeat for the same seed. */
  seed?: number;
}

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const frac = (x: number) => ((x % 1) + 1) % 1;

/**
 * Points for an LFO over content ticks [from, from + length): sine and triangle as smooth or
 * straight segments between their peaks, saw as ramps with vertical drops, square and random as
 * held steps. Values are center ± depth/2, clipped to 0–1.
 */
export function lfoPoints(from: Tick, length: Tick, o: LfoOptions): AutoPoint[] {
  const period = Math.max(1, Math.round(o.period));
  const depth = clamp01(o.depth);
  const lo = clamp01(o.center - depth / 2);
  const hi = clamp01(o.center + depth / 2);
  const end = from + Math.max(1, Math.round(length));
  const phase = ((o.phase % 1) + 1) % 1;
  // Ticks where cycles start (the first one at or before `from`).
  const cycle0 = from - phase * period;
  const out: AutoPoint[] = [];
  const push = (tick: number, value: number, extra: Partial<AutoPoint> = {}) => {
    const t = Math.round(Math.min(end, Math.max(from, tick)));
    out.push({ tick: t, value: clamp01(value), ...extra });
  };
  switch (o.shape) {
    case 'sine':
    case 'triangle': {
      // Peaks at cycle start + period/4 (high) and + 3/4 (low). Between two peaks a sine is exactly a
      // half cosine ('smooth') and a triangle a line; the part before the first peak and after the
      // last one is sampled (a sine there is no half cosine).
      const sine = o.shape === 'sine';
      const wave = (t: number) => {
        const x = frac((t - cycle0) / period);
        if (sine) return lo + (hi - lo) * (0.5 + 0.5 * Math.sin(2 * Math.PI * x));
        const tri = x < 0.25 ? 0.5 + 2 * x : x < 0.75 ? 1.5 - 2 * x : 2 * x - 1.5;
        return lo + (hi - lo) * tri;
      };
      const peaks: { t: number; v: number }[] = [];
      for (let k = Math.floor((from - cycle0) / (period / 2)) - 1; ; k++) {
        const t = cycle0 + period / 4 + (k * period) / 2;
        if (t >= end) break;
        if (t > from) peaks.push({ t, v: k % 2 === 0 ? hi : lo });
      }
      const sampled = (a: number, b: number) => {
        const step = period / 32;
        for (let t = a + step; sine && t < b - step / 2; t += step) push(t, wave(t));
      };
      push(from, wave(from));
      sampled(from, peaks[0]?.t ?? end);
      peaks.forEach((pk, i) => push(pk.t, pk.v, sine && i + 1 < peaks.length ? { shape: 'smooth' } : {}));
      if (peaks.length > 0) sampled((peaks[peaks.length - 1] as { t: number }).t, end);
      push(end, wave(end));
      break;
    }
    case 'saw': {
      const saw = (t: number) => lo + (hi - lo) * frac((t - cycle0) / period);
      push(from, saw(from));
      for (let k = Math.floor((from - cycle0) / period) + 1; ; k++) {
        const t = cycle0 + k * period;
        if (t >= end) break;
        push(t, hi);
        push(t, lo);
      }
      push(end, saw(end));
      break;
    }
    case 'square':
    case 'random': {
      let seed = (o.seed ?? 1) >>> 0;
      const rand = () => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const step = o.shape === 'square' ? period / 2 : period;
      let k = Math.floor((from - cycle0) / step);
      const level = (i: number) => (o.shape === 'square' ? (((i % 2) + 2) % 2 === 0 ? hi : lo) : lo + (hi - lo) * rand());
      let v = level(k);
      push(from, v, { shape: 'hold' });
      for (k++; ; k++) {
        const t = cycle0 + k * step;
        if (t >= end) break;
        v = level(k);
        push(t, v, { shape: 'hold' });
      }
      push(end, v);
      break;
    }
  }
  // Drop zero-length duplicates the rounding made (keep vertical jumps: same tick, other value).
  return out.filter((p, i) => i === 0 || p.tick !== out[i - 1]!.tick || p.value !== out[i - 1]!.value);
}

/** A sampled value at a song or content tick (recordings). */
export interface Sample {
  tick: number;
  value: number;
}

/**
 * Ramer–Douglas–Peucker on samples: keeps the fewest points whose straight segments stay within
 * `tolerance` (in value, 0–1) of every sample. Samples must be sorted by tick.
 */
export function thinSamples(samples: readonly Sample[], tolerance = 0.005): AutoPoint[] {
  const n = samples.length;
  if (n <= 2) return samples.map((s) => ({ tick: Math.round(s.tick), value: clamp01(s.value) }));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    const sa = samples[a] as Sample;
    const sb = samples[b] as Sample;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const s = samples[i] as Sample;
      const span = sb.tick - sa.tick;
      const line = span > 0 ? sa.value + ((sb.value - sa.value) * (s.tick - sa.tick)) / span : sa.value;
      const err = Math.abs(s.value - line);
      if (err > worst) {
        worst = err;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: AutoPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const s = samples[i] as Sample;
    out.push({ tick: Math.max(0, Math.round(s.tick)), value: clamp01(s.value) });
  }
  return out;
}

/**
 * Loop recording: passes in the order they were played (song ticks). A later pass replaces what
 * earlier passes recorded within its own span. Returns one take sorted by tick.
 */
export function mergePasses(passes: readonly (readonly Sample[])[]): Sample[] {
  let out: Sample[] = [];
  for (const pass of passes) {
    if (pass.length === 0) continue;
    const sorted = [...pass].sort((a, b) => a.tick - b.tick);
    const lo = (sorted[0] as Sample).tick;
    const hi = (sorted[sorted.length - 1] as Sample).tick;
    out = out.filter((s) => s.tick < lo || s.tick > hi).concat(sorted);
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/**
 * Puts recorded points (content ticks) into a curve: before the take and after it the curve keeps
 * its shape; in between it follows the take, with vertical jumps where they meet.
 */
export function spliceCurve(points: readonly AutoPoint[], take: readonly AutoPoint[]): AutoPoint[] {
  if (take.length === 0) return [...points];
  const from = (take[0] as AutoPoint).tick;
  const to = (take[take.length - 1] as AutoPoint).tick;
  const old = (tick: number) => curveAt(points, tick);
  const out: AutoPoint[] = points.filter((p) => p.tick < from);
  const before = old(from);
  if (before !== null && before !== (take[0] as AutoPoint).value) out.push({ tick: from, value: before });
  out.push(...take);
  const after = old(to);
  if (after !== null && after !== (take[take.length - 1] as AutoPoint).value) out.push({ tick: to, value: after });
  for (const p of points) if (p.tick > to) out.push(p);
  return out;
}
