/**
 * The peak overview of a song for the decks' waveforms: per bucket of frames the lowest and highest sample of the
 * mono mix, and how much of it is low (bass) so the drawing can color kicks and basslines differently from hats.
 * Computed a slice at a time (the caller yields between slices), so a long song doesn't stall the page.
 */

/** Frames per bucket (5.3 ms at 48 kHz): a 5-minute song is ~56 000 buckets. */
export const PEAK_BUCKET = 256;

export interface DeckWaveform {
  sampleRate: number;
  bucket: number;
  buckets: number;
  /** Lowest and highest mono sample per bucket. */
  min: Float32Array;
  max: Float32Array;
  /** Peak of the low-passed (below ~200 Hz) signal per bucket, 0…1. */
  low: Float32Array;
}

export function newWaveform(frames: number, sampleRate: number, bucket = PEAK_BUCKET): DeckWaveform {
  const buckets = Math.ceil(frames / bucket);
  return { sampleRate, bucket, buckets, min: new Float32Array(buckets), max: new Float32Array(buckets), low: new Float32Array(buckets) };
}

/** Carried between slices: the low-pass filter's memory. */
export interface PeakState {
  lp: number;
}

/** Fills buckets [from, to) from the channels (any number; mixed to mono). */
export function fillPeaks(w: DeckWaveform, channels: readonly Float32Array[], from: number, to: number, st: PeakState): void {
  const ch0 = channels[0];
  if (!ch0) return;
  const ch1 = channels[1] ?? ch0;
  const stereo = ch1 !== ch0;
  const frames = ch0.length;
  // One-pole low-pass at ~200 Hz.
  const a = 1 - Math.exp((-2 * Math.PI * 200) / w.sampleRate);
  let lp = st.lp;
  for (let b = from; b < Math.min(to, w.buckets); b++) {
    const end = Math.min(frames, (b + 1) * w.bucket);
    let lo = Infinity;
    let hi = -Infinity;
    let low = 0;
    for (let i = b * w.bucket; i < end; i++) {
      const v = stereo ? 0.5 * ((ch0[i] as number) + (ch1[i] as number)) : (ch0[i] as number);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      lp += (v - lp) * a;
      const m = lp < 0 ? -lp : lp;
      if (m > low) low = m;
    }
    w.min[b] = lo === Infinity ? 0 : lo;
    w.max[b] = hi === -Infinity ? 0 : hi;
    w.low[b] = low;
  }
  st.lp = lp;
}

/** The whole overview at once (tests, small songs). */
export function computePeaks(channels: readonly Float32Array[], sampleRate: number, bucket = PEAK_BUCKET): DeckWaveform {
  const w = newWaveform(channels[0]?.length ?? 0, sampleRate, bucket);
  fillPeaks(w, channels, 0, w.buckets, { lp: 0 });
  return w;
}

/** The overview reduced to `n` columns (the whole-song strip): min, max and low per column. */
export function reducePeaks(w: DeckWaveform, n: number, out: { min: Float32Array; max: Float32Array; low: Float32Array }): void {
  const per = w.buckets / n;
  for (let c = 0; c < n; c++) {
    const a = Math.floor(c * per);
    const b = Math.max(a + 1, Math.min(w.buckets, Math.floor((c + 1) * per)));
    let lo = Infinity;
    let hi = -Infinity;
    let low = 0;
    for (let i = a; i < b; i++) {
      const mn = w.min[i] as number;
      const mx = w.max[i] as number;
      const lw = w.low[i] as number;
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
      if (lw > low) low = lw;
    }
    out.min[c] = lo === Infinity ? 0 : lo;
    out.max[c] = hi === -Infinity ? 0 : hi;
    out.low[c] = low;
  }
}
