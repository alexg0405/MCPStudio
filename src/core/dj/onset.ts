/**
 * Onset strength for beat tracking: log-compressed spectral flux in four bands (kick, snare body,
 * snare crack / vocals, hats) on ~6 ms hops, each band whitened by its own spread so hats don't
 * drown the kick. Also keeps per-frame power (all and below 150 Hz) for the energy curve.
 * Pure TypeScript, no DOM; works at any analysis rate (22.05 kHz is what the app passes).
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../voice/fft';

export interface OnsetFeatures {
  /** Frames per second (sampleRate / hop). Frame f is centred on sample f·hop. */
  frameRate: number;
  /** Combined onset strength, ≥ 0, about unit spread. */
  onset: Float32Array;
  /** Kick and bass onsets (below 150 Hz). */
  low: Float32Array;
  /** Snare body and low mids (150–800 Hz). */
  lowMid: Float32Array;
  /** Snare crack, vocals and keys (800 Hz–4 kHz). */
  highMid: Float32Array;
  /** Hats and cymbals (above 4 kHz). */
  high: Float32Array;
  /** Power per frame (all frequencies) and below 150 Hz, in the signal's own scale. */
  power: Float32Array;
  lowPower: Float32Array;
}

/** Band edges in Hz: [low, lowMid, highMid, high]. */
const EDGES = [25, 150, 800, 4000, Infinity] as const;
/** How much each band counts in the combined onset strength (kick and snare lead). */
const WEIGHTS = [1, 0.9, 0.7, 0.55] as const;

/** Mean over a centred window of `half` frames each side (running sum). */
export function movingMean(x: ArrayLike<number>, half: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  let sum = 0;
  let a = 0;
  let b = 0; // window [a, b)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    while (b < hi) sum += x[b++]!;
    while (a < lo) sum -= x[a++]!;
    out[i] = sum / (b - a);
  }
  return out;
}

function spread(x: Float32Array): number {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]!;
    s2 += x[i]! * x[i]!;
  }
  const n = Math.max(1, x.length);
  const mean = s / n;
  return Math.sqrt(Math.max(0, s2 / n - mean * mean));
}

export function onsetFeatures(
  mono: Float32Array,
  sampleRate: number,
  progress?: (fraction: number) => void,
): OnsetFeatures {
  const size = nextPowerOfTwo(Math.round(0.046 * sampleRate));
  const hop = size / 8;
  const fft = new RealFFT(size);
  const win = hannWindow(size);
  const mag = new Float64Array(fft.bins);
  const frames = Math.max(0, Math.ceil(mono.length / hop));
  // Level-independent compression: scale so the whole song has an RMS of 0.1.
  let sq = 0;
  for (let i = 0; i < mono.length; i++) sq += mono[i]! * mono[i]!;
  const rms = Math.sqrt(sq / Math.max(1, mono.length));
  const gain = rms > 1e-7 ? (0.1 / rms) * (4 / size) : 0;
  const bandOf = new Int8Array(fft.bins).fill(-1);
  for (let k = 1; k < fft.bins; k++) {
    const f = (k * sampleRate) / size;
    for (let b = 0; b < 4; b++) if (f >= EDGES[b]! && f < EDGES[b + 1]!) bandOf[k] = b;
  }
  const lowTop = Math.floor((150 * size) / sampleRate);
  // Log magnitudes of the last two frames (flux compares frames two hops apart: ~12 ms).
  const prev2 = new Float64Array(fft.bins);
  const prev1 = new Float64Array(fft.bins);
  const bands = [0, 1, 2, 3].map(() => new Float32Array(frames));
  const power = new Float32Array(frames);
  const lowPower = new Float32Array(frames);
  const flux = new Float64Array(4);
  const step = Math.max(1, Math.floor(frames / 20));
  for (let f = 0; f < frames; f++) {
    magnitudeSpectrum(fft, mono, f * hop - size / 2, win, mag);
    flux.fill(0);
    let p = 0;
    let pl = 0;
    for (let k = 1; k < fft.bins; k++) {
      const m = mag[k]! * gain;
      const e = m * m;
      p += e;
      if (k <= lowTop) pl += e;
      const v = Math.log1p(100 * m);
      const b = bandOf[k]!;
      if (b >= 0) {
        const d = v - prev2[k]!;
        if (d > 0) flux[b] = flux[b]! + d;
      }
      prev2[k] = prev1[k]!;
      prev1[k] = v;
    }
    power[f] = p;
    lowPower[f] = pl;
    // The difference over two hops peaks one hop early: file it under the frame between.
    if (f >= 2) for (let b = 0; b < 4; b++) bands[b]![f - 1] = flux[b]!;
    if (progress && f % step === 0) progress(f / frames);
  }
  // Whitening: subtract a local mean (~0.25 s) so sustained textures don't count, keep the rises,
  // then scale each band to unit spread.
  const half = Math.round((0.125 * sampleRate) / hop);
  const onset = new Float32Array(frames);
  for (let b = 0; b < 4; b++) {
    const x = bands[b]!;
    const mean = movingMean(x, half);
    for (let i = 0; i < frames; i++) x[i] = Math.max(0, x[i]! - mean[i]!);
    const s = spread(x);
    if (s > 1e-9) for (let i = 0; i < frames; i++) x[i] = x[i]! / s;
    const w = WEIGHTS[b]!;
    for (let i = 0; i < frames; i++) onset[i] = onset[i]! + w * x[i]!;
  }
  return {
    frameRate: sampleRate / hop,
    onset,
    low: bands[0]!,
    lowMid: bands[1]!,
    highMid: bands[2]!,
    high: bands[3]!,
    power,
    lowPower,
  };
}
