// The shape of one drawable wavetable frame: the Fourier series it is stored as, and its time and frequency views.
// Pure TypeScript with no DOM (see wavetable-frames.ts for the whole picture).
import { fft, WT_HARMONICS } from './wavetable';

/** Samples per cycle of the drawing buffer (`frameToWave`'s default size): 1024 points hold all 256 harmonics. */
export const FRAME_POINTS = 1024;
/** Harmonics a frame keeps (the richest mip level of a bank). */
export const FRAME_HARMONICS = WT_HARMONICS;
/** Key frames in one table. */
export const MAX_FRAMES = 32;

/**
 * One single-cycle shape as a Fourier series: x(t) = cos[0] + Σ cos[k]·cos(2πkt) + sin[k]·sin(2πkt), k = 1…256
 * (`cos[0]` is the DC offset, which a bank drops: it is not heard, and `removeDc` clears it).
 */
export interface Frame {
  readonly sin: Float64Array;
  readonly cos: Float64Array;
}

/** A silent frame: every harmonic and the DC offset at zero. */
export function newFrame(): Frame {
  return { sin: new Float64Array(FRAME_HARMONICS + 1), cos: new Float64Array(FRAME_HARMONICS + 1) };
}

/** A copy of the frame that shares nothing with it. */
export function cloneFrame(f: Frame): Frame {
  return { sin: Float64Array.from(f.sin), cos: Float64Array.from(f.cos) };
}

/** A frame with nothing in it. */
export function isSilent(f: Frame): boolean {
  for (let k = 1; k <= FRAME_HARMONICS; k++) if (f.sin[k] !== 0 || f.cos[k] !== 0) return false;
  return true;
}

const isPow2 = (n: number) => n > 1 && (n & (n - 1)) === 0;

// ---------------------------------------------------------------------------------------------
// Time and frequency views.

/** One cycle of a frame as `out.length` points (a power of two, default `FRAME_POINTS`), DC included. */
export function frameToWave(f: Frame, out: Float32Array = new Float32Array(FRAME_POINTS)): Float32Array {
  const n = out.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const h = Math.min(FRAME_HARMONICS, n / 2 - 1);
  re[0] = f.cos[0] as number;
  for (let k = 1; k <= h; k++) {
    const c = (f.cos[k] as number) / 2;
    const s = (f.sin[k] as number) / 2;
    re[k] = c;
    im[k] = -s;
    re[n - k] = c;
    im[n - k] = s;
  }
  fft(re, im, n, true);
  for (let i = 0; i < n; i++) out[i] = re[i] as number;
  return out;
}

/** Averages `src` down to `m` points (a box filter over the fraction of the input each output point covers). */
export function boxResample(src: ArrayLike<number>, m: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(m);
  const ratio = n / m;
  for (let i = 0; i < m; i++) {
    const a = i * ratio;
    const b = a + ratio;
    let sum = 0;
    for (let j = Math.floor(a); j < Math.min(n, Math.ceil(b)); j++) {
      const w = Math.min(b, j + 1) - Math.max(a, j);
      sum += (src[j] as number) * w;
    }
    out[i] = sum / ratio;
  }
  return out;
}

/** The longest cycle `frameFromWave` analyses directly; longer input is averaged down to it first. */
export const MAX_ANALYSIS = 4096;

/**
 * The harmonics 1…256 (and the DC offset) of one cycle of audio of any length ≥ 4: a power of two goes through the
 * FFT, other lengths through a direct transform, so a single-cycle file of 600 or 2000 samples reads exactly.
 * A cycle shorter than 514 samples has fewer harmonics (up to n/2 − 1).
 */
export function frameFromWave(wave: ArrayLike<number>): Frame {
  const f = newFrame();
  let src: ArrayLike<number> = wave;
  if (src.length > MAX_ANALYSIS) src = boxResample(src, MAX_ANALYSIS);
  const n = src.length;
  if (n < 4) return f;
  const kmax = Math.min(FRAME_HARMONICS, (n >> 1) - 1);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += src[i] as number;
  f.cos[0] = mean / n;
  if (isPow2(n)) {
    const re = Float64Array.from(src);
    const im = new Float64Array(n);
    fft(re, im, n, false);
    for (let k = 1; k <= kmax; k++) {
      f.cos[k] = (2 * (re[k] as number)) / n;
      f.sin[k] = (-2 * (im[k] as number)) / n;
    }
    return f;
  }
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    cosT[j] = Math.cos((2 * Math.PI * j) / n);
    sinT[j] = Math.sin((2 * Math.PI * j) / n);
  }
  for (let k = 1; k <= kmax; k++) {
    let c = 0;
    let s = 0;
    for (let j = 0, idx = 0; j < n; j++, idx = (idx + k) % n) {
      const x = src[j] as number;
      c += x * (cosT[idx] as number);
      s += x * (sinT[idx] as number);
    }
    f.cos[k] = (2 * c) / n;
    f.sin[k] = (2 * s) / n;
  }
  return f;
}

/** The size of the largest peak of the frame's shape (DC included). */
export function peakOf(f: Frame): number {
  const w = frameToWave(f);
  let p = 0;
  for (let i = 0; i < w.length; i++) p = Math.max(p, Math.abs(w[i] as number));
  return p;
}

/** Strength of harmonics 1…count (√(sin² + cos²)). */
export function harmonicAmps(f: Frame, count: number): Float64Array {
  const out = new Float64Array(count);
  for (let k = 1; k <= count && k <= FRAME_HARMONICS; k++)
    out[k - 1] = Math.hypot(f.sin[k] as number, f.cos[k] as number);
  return out;
}
