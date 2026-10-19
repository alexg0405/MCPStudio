/**
 * Curves made by tools rather than by hand: LFO shapes, and recorded knob moves thinned to a few
 * points (Ramer–Douglas–Peucker).
 */
import type { AutoPoint, Tick } from '../model/types';
import { curveAt } from './curve';

/** The wave shapes the LFO generator can draw. */
export type LfoShape = 'sine' | 'triangle' | 'saw' | 'square' | 'random';
/** Every `LfoShape`, for lists and for checking loose input. */
export const LFO_SHAPES: readonly LfoShape[] = ['sine', 'triangle', 'saw', 'square', 'random'];

/**
 * What an LFO curve is made from: its shape, cycle length (ticks), size and middle (0..1 of the target's range),
 * starting point in the cycle and a seed for the random shape.
 */
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

/** The geometry every LFO shape is drawn from. */
interface Wave {
  /** The range drawn: content ticks [from, end]. */
  from: Tick;
  end: Tick;
  period: Tick;
  /** The wave's low and high values, 0–1. */
  lo: number;
  hi: number;
  /** Where a cycle starts (the first one at or before `from`). */
  cycle0: Tick;
}

/** Collects points inside [from, end], rounding ticks and clipping values to 0–1. */
class PointWriter {
  readonly points: AutoPoint[] = [];

  constructor(
    private readonly from: Tick,
    private readonly end: Tick,
  ) {}

  push(tick: number, value: number, extra: Partial<AutoPoint> = {}): void {
    const t = Math.round(Math.min(this.end, Math.max(this.from, tick)));
    this.points.push({ tick: t, value: clamp01(value), ...extra });
  }
}

/** How many samples a smooth stretch of a sine gets per cycle, where it is not between two peaks. */
const SAMPLES_PER_CYCLE = 32;

/**
 * Points for an LFO over content ticks [from, from + length): sine and triangle as smooth or
 * straight segments between their peaks, saw as ramps with vertical drops, square and random as
 * held steps. Values are center ± depth/2, clipped to 0–1.
 */
export function lfoPoints(from: Tick, length: Tick, o: LfoOptions): AutoPoint[] {
  const period = Math.max(1, Math.round(o.period));
  const depth = clamp01(o.depth);
  const end = from + Math.max(1, Math.round(length));
  const phase = ((o.phase % 1) + 1) % 1;
  const wave: Wave = {
    from,
    end,
    period,
    lo: clamp01(o.center - depth / 2),
    hi: clamp01(o.center + depth / 2),
    cycle0: from - phase * period,
  };
  const out = new PointWriter(from, end);
  switch (o.shape) {
    case 'sine':
      peakWave(out, wave, true);
      break;
    case 'triangle':
      peakWave(out, wave, false);
      break;
    case 'saw':
      sawWave(out, wave);
      break;
    default:
      steppedWave(out, wave, o.shape === 'square', o.seed ?? 1);
  }
  // Drop zero-length duplicates the rounding made (keep vertical jumps: same tick, other value).
  return out.points.filter(
    (p, i) => i === 0 || p.tick !== out.points[i - 1]!.tick || p.value !== out.points[i - 1]!.value,
  );
}

/**
 * Sine or triangle. A cycle starts at its low point and peaks halfway. Between two peaks a sine is exactly a
 * half cosine ('smooth') and a triangle a line; a part before the first peak or after the last one (a phase or
 * length that isn't a whole half cycle) is sampled.
 */
function peakWave(out: PointWriter, w: Wave, isSine: boolean): void {
  const { from, end, period, lo, hi, cycle0 } = w;
  const value = (t: number) => {
    const x = frac((t - cycle0) / period);
    if (isSine) return lo + (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * x));
    return lo + (hi - lo) * (x < 0.5 ? 2 * x : 2 - 2 * x);
  };
  const half = period / 2;
  const peaks: { t: number; v: number }[] = [];
  for (let k = Math.ceil((from - cycle0) / half - 1e-9); ; k++) {
    const t = cycle0 + k * half;
    if (t > end + 1e-9) break;
    peaks.push({ t, v: ((k % 2) + 2) % 2 === 0 ? lo : hi });
  }
  // Only a sine needs samples in the partial stretches (a triangle is straight there).
  const sampled = (a: number, b: number) => {
    const step = period / SAMPLES_PER_CYCLE;
    for (let t = a + step; isSine && t < b - step / 2; t += step) out.push(t, value(t));
  };
  const first = peaks[0]?.t ?? end;
  const last = peaks[peaks.length - 1]?.t ?? from;
  if (first > from + 0.5) {
    out.push(from, value(from));
    sampled(from, first);
  }
  peaks.forEach((pk, i) => out.push(pk.t, pk.v, isSine && i + 1 < peaks.length ? { shape: 'smooth' } : {}));
  if (last < end - 0.5) {
    sampled(last, end);
    out.push(end, value(end));
  }
}

/** Saw: a ramp from low to high every cycle, with a vertical drop at each cycle start. */
function sawWave(out: PointWriter, w: Wave): void {
  const { from, end, period, lo, hi, cycle0 } = w;
  const saw = (t: number) => lo + (hi - lo) * frac((t - cycle0) / period);
  out.push(from, saw(from));
  for (let k = Math.floor((from - cycle0) / period) + 1; ; k++) {
    const t = cycle0 + k * period;
    if (t >= end) break;
    out.push(t, hi);
    out.push(t, lo);
  }
  out.push(end, saw(end));
}

/** Square (a step per half cycle, high then low) or random (a new random level every cycle, the same for the same seed), held steps. */
function steppedWave(out: PointWriter, w: Wave, isSquare: boolean, seedIn: number): void {
  const { from, end, period, lo, hi, cycle0 } = w;
  let seed = seedIn >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const step = isSquare ? period / 2 : period;
  let k = Math.floor((from - cycle0) / step);
  const level = (i: number) => {
    if (!isSquare) return lo + (hi - lo) * rand();
    return ((i % 2) + 2) % 2 === 0 ? hi : lo;
  };
  let v = level(k);
  out.push(from, v, { shape: 'hold' });
  for (k++; ; k++) {
    const t = cycle0 + k * step;
    if (t >= end) break;
    v = level(k);
    out.push(t, v, { shape: 'hold' });
  }
  out.push(end, v);
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
