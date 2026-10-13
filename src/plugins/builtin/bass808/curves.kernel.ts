/**
 * Pure DSP helpers for the 808 (no Web Audio; unit-tested in Node): the drive curve and its gain
 * staging, and the click transient.
 *
 * Drive: a fixed tanh curve with a gain in front (smoothed by the host, unlike rewriting the curve)
 * and a make-up gain after it. The gain sweeps 50 dB, so a full-level note goes from clean (third
 * harmonic about -60 dB at 0) through warm, mostly third-harmonic saturation (about -37 dB at 0.25,
 * -17 dB at 0.5) to a buzzing near-square wave (seventh to eleventh harmonics within -30 dB of the
 * fundamental from 0.75 up). The curve is odd, so it adds no DC and keeps zero crossings in place.
 */

/** Signal level at either end of the curve; tanh(5) is within 1e-4 of 1, so clamping beyond is inaudible. */
export const CURVE_RANGE = 5;
/** Odd, so 0 lands exactly on the centre point and silence stays silent. */
export const CURVE_POINTS = 4097;

/** Gain into tanh at drive 0 (clean: tanh is linear within 0.3% there) and the range above it. */
const MIN_GAIN = 0.1;
const GAIN_RANGE_DB = 50;

let curveCache: Float32Array<ArrayBuffer> | null = null;

/** The sampled curve: input [-1, 1] maps to tanh over ±CURVE_RANGE (cached; WaveShaperNode copies it). */
export function driveCurve(): Float32Array<ArrayBuffer> {
  if (!curveCache) {
    const c = new Float32Array(CURVE_POINTS);
    const mid = (CURVE_POINTS - 1) / 2;
    for (let i = 0; i < CURVE_POINTS; i++) c[i] = Math.tanh(((i - mid) / mid) * CURVE_RANGE);
    curveCache = c;
  }
  return curveCache;
}

/** Gain into tanh for a drive of 0–1 (the shaper's input is this divided by CURVE_RANGE). */
export function driveGain(drive: number): number {
  return MIN_GAIN * Math.pow(10, (GAIN_RANGE_DB * Math.min(1, Math.max(0, drive))) / 20);
}

/**
 * Make-up gain after the curve: a full-level sine comes out with the same RMS at any drive, so the
 * knob changes the colour and the sustain (quiet tails get louder as the peaks saturate), not the
 * loudness of the hit.
 */
export function driveMakeup(drive: number): number {
  const g = driveGain(drive);
  const n = 256;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.tanh(g * Math.sin((2 * Math.PI * (i + 0.5)) / n)) ** 2;
  return Math.SQRT1_2 / Math.sqrt(sum / n);
}

/** Length of the click transient. */
export const CLICK_SECONDS = 0.006;

/**
 * The click: a fast downward chirp (about 3.3 kHz to 700 Hz) with a few milliseconds of decay,
 * starting at zero phase, peak-normalized to 1. Deterministic for a given sample rate.
 */
export function clickWave(sampleRate: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(CLICK_SECONDS * sampleRate));
  const out = new Float32Array(n);
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq = 700 + 2600 * Math.exp(-t / 0.0012);
    // A short fade-out keeps the end of the buffer at exactly zero.
    const fade = Math.min(1, (n - 1 - i) / (0.001 * sampleRate));
    const v = Math.sin(phase) * Math.exp(-t / 0.0011) * fade;
    phase += (2 * Math.PI * freq) / sampleRate;
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] as number) / peak;
  return out;
}
