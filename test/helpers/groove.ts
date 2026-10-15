/**
 * Measurements for the groove tests (browser): tone shares, onsets, pitch over time. Pure
 * TypeScript on Float32Arrays, so the same helpers also run in Node.
 */
import { Measurer } from '@app/analysis/measure';

/** The left channel and right channel of a buffer from `from` (frames) on. */
export function channels(buffer: AudioBuffer, from = 0, to = buffer.length): [Float32Array, Float32Array] {
  const l = buffer.getChannelData(0).subarray(from, to);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).subarray(from, to) : l;
  return [l, r];
}

/** Share (percent) of a signal's energy above 4 kHz (the Measurer's presence + air bands). */
export function highShare(buffer: AudioBuffer, from = 0, to = buffer.length): number {
  const [l, r] = channels(buffer, from, to);
  const m = new Measurer(buffer.sampleRate);
  m.push(l, r);
  const bands = m.result().bands;
  return (bands[4] ?? 0) + (bands[5] ?? 0);
}

/**
 * Onsets (fractional frames) of clicks in `x`: where |x| first rises over `threshold` after at
 * least `gap` frames below it, refined to the sub-frame crossing.
 */
export function clickOnsets(x: Float32Array, threshold: number, gap: number): number[] {
  const out: number[] = [];
  let quietSince = -Infinity;
  let last = -Infinity;
  for (let i = 1; i < x.length; i++) {
    const a = Math.abs(x[i - 1] as number);
    const b = Math.abs(x[i] as number);
    if (b > threshold && a <= threshold && i - last > gap) {
      out.push(i - 1 + (threshold - a) / (b - a));
      quietSince = i;
    }
    if (b > threshold) last = i;
  }
  void quietSince;
  return out;
}

/** Upward zero crossings (fractional frames) in [from, to). */
export function upCrossings(x: Float32Array, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) {
    const a = x[i - 1] as number;
    const b = x[i] as number;
    if (a < 0 && b >= 0) out.push(i - 1 + a / (a - b));
  }
  return out;
}

/** Mean frequency over [from, to) frames from upward zero crossings (0 if fewer than two). */
export function zeroCrossingHz(x: Float32Array, sampleRate: number, from: number, to: number): number {
  const c = upCrossings(x, from, to);
  if (c.length < 2) return 0;
  return ((c.length - 1) * sampleRate) / ((c[c.length - 1] as number) - (c[0] as number));
}

/** Peak |x| over [from, to). */
export function peakIn(x: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i] as number));
  return m;
}
