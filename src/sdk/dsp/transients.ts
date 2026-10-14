// Slicing samples: a peak overview, transient (hit) detection and even grids. Pure functions with
// allocation-free variants, usable on any thread.

/** Frames per bucket of the host's waveform overview (`PluginUISamples.waveform`). */
export const OVERVIEW_BUCKET = 256;

/**
 * Min and max per bucket of `bucket` frames over all channels, interleaved `[min0, max0, min1, …]`
 * (each starts at 0, so min ≤ 0 ≤ max). It is the same overview the host draws waveforms from, so
 * slices found from it line up with what an editor shows.
 */
export function peakOverview(
  channels: readonly Float32Array[],
  bucket = OVERVIEW_BUCKET,
  out?: Float32Array,
): Float32Array {
  const length = channels[0]?.length ?? 0;
  const buckets = Math.max(1, Math.ceil(length / bucket));
  const peaks = out && out.length >= buckets * 2 ? out : new Float32Array(buckets * 2);
  peaks.fill(0, 0, buckets * 2);
  for (let c = 0; c < channels.length; c++) {
    const data = channels[c] as Float32Array;
    for (let b = 0; b < buckets; b++) {
      let lo = peaks[b * 2] as number;
      let hi = peaks[b * 2 + 1] as number;
      const end = Math.min(data.length, (b + 1) * bucket);
      for (let i = b * bucket; i < end; i++) {
        const v = data[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      peaks[b * 2] = lo;
      peaks[b * 2 + 1] = hi;
    }
  }
  return peaks;
}

export interface SliceOptions {
  /** 0–1: higher finds quieter and softer hits (more slices). */
  sensitivity: number;
  /** Shortest slice in seconds (hits closer than this merge). */
  minLength: number;
  /** At most this many slices. */
  max: number;
}

/** A hit is a jump in level over the quietest of the previous few buckets (~16 ms). */
const LOOKBACK = 3;

/**
 * Finds hits (transients) in a peak overview and writes the slice start frames to `out` (sorted);
 * returns how many. A bucket starts a slice when its level jumps above the quietest of the previous
 * three buckets by a threshold that `sensitivity` lowers (14 dB at 0, 8 dB at 0.5, 2 dB at 1), and
 * it is not too quiet compared with the loudest point (−30 dB at 0, −60 dB at 1). Hits closer than
 * `minLength` merge. Silence before the first hit is skipped; otherwise the first slice starts at
 * frame 0. `scratch` (one number per bucket) avoids allocating.
 */
export function detectSlicesInto(
  peaks: Float32Array,
  buckets: number,
  bucket: number,
  sampleRate: number,
  opts: SliceOptions,
  out: Int32Array | number[],
  scratch?: Float64Array,
): number {
  const max = Math.min(opts.max, out.length);
  if (buckets <= 0 || max <= 0) return 0;
  const level = scratch && scratch.length >= buckets ? scratch : new Float64Array(buckets);
  let loudest = 0;
  for (let b = 0; b < buckets; b++) {
    const lo = -(peaks[b * 2] as number);
    const hi = peaks[b * 2 + 1] as number;
    const v = lo > hi ? lo : hi;
    level[b] = v;
    if (v > loudest) loudest = v;
  }
  if (!(loudest > 0)) {
    out[0] = 0;
    return 1;
  }
  const s = opts.sensitivity < 0 ? 0 : opts.sensitivity > 1 ? 1 : opts.sensitivity;
  const rise = 14 - 12 * s;
  const floor = loudest * Math.pow(10, -(30 + 30 * s) / 20);
  const silence = loudest * Math.pow(10, -50 / 20);
  const minGap = Math.max(1, Math.round((opts.minLength * sampleRate) / bucket));
  // In dB, with a floor so silence doesn't count as huge jumps.
  const silenceDb = 20 * Math.log10(silence);
  for (let b = 0; b < buckets; b++) level[b] = 20 * Math.log10(Math.max(level[b] as number, silence));
  const floorDb = 20 * Math.log10(floor);

  let count = 0;
  let last = 0;
  // Whether anything above silence came before the bucket being looked at.
  let heard = false;
  // A hit spans a few rising buckets: only the first of them starts a slice.
  let rising = false;
  for (let b = 0; b < buckets && count < max; b++) {
    const v = level[b] as number;
    let prev = b === 0 ? silenceDb : Infinity;
    for (let j = Math.max(0, b - LOOKBACK); j < b; j++) if ((level[j] as number) < prev) prev = level[j] as number;
    const candidate = v >= floorDb && v - prev >= rise;
    const onset = candidate && !rising;
    rising = candidate;
    if (onset && (count === 0 || b - last >= minGap)) {
      if (count === 0 && heard) {
        // Sound before the first hit stays in the first slice (merged when the hit is that close).
        out[count++] = 0;
        last = 0;
        if (b < minGap) continue;
        if (count >= max) break;
      }
      out[count++] = b * bucket;
      last = b;
    }
    if (v > silenceDb + 1) heard = true;
  }
  if (count === 0) out[count++] = 0;
  return count;
}

/** `detectSlicesInto` returning a new array of slice start frames. */
export function detectSlices(peaks: Float32Array, bucket: number, sampleRate: number, opts: SliceOptions): number[] {
  const buckets = peaks.length >> 1;
  const out = new Array<number>(Math.max(1, opts.max)).fill(0);
  const n = detectSlicesInto(peaks, buckets, bucket, sampleRate, opts, out);
  return out.slice(0, n);
}

/** Writes `count` equal slices of a `length`-frame sample (a beat grid for loops) to `out`; returns how many. */
export function gridSlicesInto(length: number, count: number, out: Int32Array | number[]): number {
  const n = Math.max(1, Math.min(Math.round(count), out.length));
  for (let i = 0; i < n; i++) out[i] = Math.round((i * length) / n);
  return n;
}
