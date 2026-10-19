import { PITCH_NOTE_THRESHOLDS as T, median, type PitchNote } from './shared';

/** Drift is read from this share of the slow line's range: its 3rd to 97th percentile. */
const DRIFT_LOW_SHARE = 0.03;
const DRIFT_HIGH_SHARE = 0.97;
/** A note needs at least this many frames of slow line to have a drift, and this many of deviation to have vibrato. */
const MIN_DRIFT_FRAMES = 8;
const MIN_VIBRATO_FRAMES = 12;
/** A note is "long" for drift when it has this many frames beyond the two edges the slow line is trimmed by. */
const LONG_NOTE_EXTRA_FRAMES = 12;
/** Vibrato depth is the 5th to 95th percentile of the deviation from the slow line. */
const DEPTH_LOW_SHARE = 0.05;
const DEPTH_HIGH_SHARE = 0.95;
/** The deviation must pass this share of the depth (either side of zero) to count as a swing: a dead band against wobble. */
const DEAD_BAND_SHARE = 0.15;
/** Vibrato needs at least this many zero crossings. */
const MIN_CROSSINGS = 3;

/**
 * The slow pitch line of frames [i0, i1]: a moving average (`win` frames, centred, clipped to the
 * range) of the voiced frames; NaN where unvoiced. It follows glides and drift but not vibrato.
 */
export function slowLine(cents: Float64Array, i0: number, i1: number, win: number): Float64Array {
  const len = i1 - i0 + 1;
  const sum = new Float64Array(len + 1);
  const cnt = new Int32Array(len + 1);
  for (let k = 0; k < len; k++) {
    const v = cents[i0 + k] as number;
    sum[k + 1] = (sum[k] as number) + (Number.isNaN(v) ? 0 : v);
    cnt[k + 1] = (cnt[k] as number) + (Number.isNaN(v) ? 0 : 1);
  }
  const half = Math.max(1, Math.round(win / 2));
  const out = new Float64Array(len);
  for (let k = 0; k < len; k++) {
    if (Number.isNaN(cents[i0 + k] as number)) {
      out[k] = Number.NaN;
      continue;
    }
    // The window may not be wider than the note itself on either side of the frame (it shrinks at the ends).
    const reach = Math.min(half, k, len - 1 - k);
    const lo = k - Math.max(1, reach);
    const hi = Math.min(len, k + Math.max(1, reach) + 1);
    const l = Math.max(0, lo);
    const c = (cnt[hi] as number) - (cnt[l] as number);
    out[k] = c > 0 ? ((sum[hi] as number) - (sum[l] as number)) / c : (cents[i0 + k] as number);
  }
  return out;
}

/** The value at a share of the way through the sorted values (rounded down for the low share, up for the high). */
const percentile = (sorted: number[], share: number, round: (x: number) => number): number =>
  sorted[round(share * (sorted.length - 1))] as number;

/** The slow line's values and the deviations of the note's cents from it, trimmed at both ends of a long note. */
function slowAndDeviation(
  cents: Float64Array,
  i0: number,
  i1: number,
  hop: number,
): { slowVals: number[]; dev: number[]; isLong: boolean } {
  const slow = slowLine(cents, i0, i1, Math.round(T.slowSec / hop));
  // Drift is measured away from the ends, where the window is short (vibrato leaks through) and the
  // note glides in; a note too short for that has no measurable drift.
  const half = Math.max(1, Math.round(Math.round(T.slowSec / hop) / 2));
  const isLong = i1 - i0 + 1 >= 2 * half + LONG_NOTE_EXTRA_FRAMES;
  const edge = isLong ? half : 0;
  const slowVals: number[] = [];
  const dev: number[] = [];
  for (let k = isLong ? edge : 0; k < slow.length - edge; k++) {
    const s = slow[k] as number;
    if (Number.isNaN(s)) continue;
    slowVals.push(s);
    dev.push((cents[i0 + k] as number) - s);
  }
  return { slowVals, dev, isLong };
}

/** How far the slow line wanders (3rd to 97th percentile, cents); 0 for a short note or too few frames. */
function driftOf(slowVals: number[], isLong: boolean): number {
  if (!isLong || slowVals.length < MIN_DRIFT_FRAMES) return 0;
  const sorted = slowVals.slice().sort((a, b) => a - b);
  return percentile(sorted, DRIFT_HIGH_SHARE, Math.ceil) - percentile(sorted, DRIFT_LOW_SHARE, Math.floor);
}

/** Vibrato depth (cents peak to peak) and rate (Hz) of the deviation from the slow line; both 0 when it is not vibrato. */
function vibratoOf(dev: number[], hop: number): { depth: number; rate: number } {
  const none = { depth: 0, rate: 0 };
  if (dev.length < MIN_VIBRATO_FRAMES) return none;
  const sorted = dev.slice().sort((a, b) => a - b);
  const depth = percentile(sorted, DEPTH_HIGH_SHARE, Math.ceil) - percentile(sorted, DEPTH_LOW_SHARE, Math.floor);
  // Rate from the zero crossings of the deviation (with a dead band against wobble).
  const band = DEAD_BAND_SHARE * depth;
  let crossings = 0;
  let state = 0;
  let firstAt = 0;
  let lastAt = 0;
  for (let k = 0; k < dev.length; k++) {
    const d = dev[k] as number;
    const side = swingSide(d, band);
    if (side === 0 || side === state) continue;
    if (state !== 0) {
      if (crossings === 0) firstAt = k;
      lastAt = k;
      crossings++;
    }
    state = side;
  }
  // Half a cycle between neighbouring crossings: measured from the first to the last one.
  const rate = lastAt > firstAt ? (crossings - 1) / (2 * (lastAt - firstAt) * hop) : 0;
  const isVibrato =
    depth >= T.vibratoMinDepth && crossings >= MIN_CROSSINGS && rate >= T.vibratoRate[0] && rate <= T.vibratoRate[1];
  return isVibrato ? { depth, rate } : none;
}

/** Which side of zero a deviation is on once it is past the dead band: 1 above, −1 below, 0 inside. */
function swingSide(deviation: number, band: number): number {
  if (deviation > band) return 1;
  return deviation < -band ? -1 : 0;
}

/** Statistics of one note over frames [i0, i1] of a track. */
export function noteStats(
  f0: Float32Array,
  cents: Float64Array,
  i0: number,
  i1: number,
  hop: number,
): Pick<PitchNote, 'pitch' | 'drift' | 'vibratoDepth' | 'vibratoRate'> {
  const voiced: number[] = [];
  for (let i = i0; i <= i1; i++) if ((f0[i] as number) > 0) voiced.push(cents[i] as number);
  const pitch = voiced.length ? median(voiced) / 100 : 0;
  const { slowVals, dev, isLong } = slowAndDeviation(cents, i0, i1, hop);
  const vibrato = vibratoOf(dev, hop);
  return { pitch, drift: driftOf(slowVals, isLong), vibratoDepth: vibrato.depth, vibratoRate: vibrato.rate };
}
