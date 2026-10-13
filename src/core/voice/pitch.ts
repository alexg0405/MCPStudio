/**
 * Monophonic pitch tracking with YIN (de Cheveigné & Kawahara, 2002): difference function,
 * cumulative mean normalized difference (CMND), absolute threshold, parabolic interpolation.
 * The difference function comes from an FFT cross-correlation, and the signal is first decimated
 * to about 8 kHz (enough for voice fundamentals up to 1 kHz), which keeps 30 s of audio well
 * under 100 ms.
 */
import { decimate } from './filters';
import { RealFFT, nextPowerOfTwo } from './fft';

export interface PitchOptions {
  /** Lowest detectable fundamental in Hz (default 40). */
  minHz?: number;
  /** Highest detectable fundamental in Hz (default 1000). */
  maxHz?: number;
  /** Frame hop in samples at the input rate (default ≈ 5 ms). */
  hop?: number;
  /** YIN integration window in samples at the input rate (default one period of `minHz`, at least 10 ms). */
  window?: number;
}

export interface PitchTrack {
  /** Frame centers in seconds; frame i is at i × hop / sampleRate. */
  times: Float32Array;
  /** Fundamental in Hz, 0 when unvoiced (aperiodic, or below the silence floor). */
  f0: Float32Array;
  /** 0..1: 1 − the CMND minimum (1 = perfectly periodic). Reported for unvoiced frames too. */
  confidence: Float32Array;
}

/** YIN's absolute threshold: the first CMND dip below it is taken as the period. */
export const YIN_THRESHOLD = 0.15;
/** Frames whose best CMND value is above this are unvoiced (f0 = 0). */
export const YIN_MAX_APERIODICITY = 0.35;
/** Frames quieter than this (dB below the loudest frame) are unvoiced. */
const SILENCE_DB = 50;
/** Absolute silence floor (RMS). */
const SILENCE_RMS = 1e-5;
/** Lowest rate the tracker decimates to. */
const MIN_ANALYSIS_RATE = 8000;

export function hzToMidi(hz: number): number {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN;
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Largest decimation factor that keeps the analysis rate ≥ max(8 kHz, 8 × maxHz). */
export function pitchDecimation(sampleRate: number, maxHz: number): number {
  return Math.max(1, Math.floor(sampleRate / Math.max(MIN_ANALYSIS_RATE, 8 * maxHz)));
}

/**
 * One-frame YIN estimator at a fixed rate. Reuses its buffers: `estimate()` allocates nothing and
 * leaves its result in `f0`, `aperiodicity` and `energy`.
 */
export class Yin {
  readonly sampleRate: number;
  readonly tauMin: number;
  readonly tauMax: number;
  /** Integration window W. */
  readonly window: number;
  /** Samples one frame reads: W + tauMax. */
  readonly span: number;
  /** Where a frame's span starts relative to its center, so the analysed region is centered for mid-range pitches. */
  readonly lead: number;

  /** Hz, 0 when unvoiced. */
  f0 = 0;
  /** CMND value at the chosen period (0 = periodic, ~1 = noise). */
  aperiodicity = 1;
  /** Mean square of the integration window. */
  energy = 0;

  private readonly fft: RealFFT;
  private readonly a: Float64Array;
  private readonly b: Float64Array;
  private readonly ar: Float64Array;
  private readonly ai: Float64Array;
  private readonly br: Float64Array;
  private readonly bi: Float64Array;
  private readonly r: Float64Array;
  private readonly d: Float64Array;
  private readonly cmnd: Float64Array;

  constructor(sampleRate: number, minHz: number, maxHz: number, window: number) {
    this.sampleRate = sampleRate;
    this.tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    this.tauMax = Math.max(this.tauMin + 2, Math.ceil(sampleRate / minHz));
    this.window = Math.max(4, Math.round(window));
    this.span = this.window + this.tauMax;
    const tauMid = Math.sqrt(this.tauMin * this.tauMax);
    this.lead = Math.round((this.window + tauMid) / 2);
    const n = nextPowerOfTwo(this.span);
    this.fft = new RealFFT(Math.max(2, n));
    const bins = this.fft.bins;
    this.a = new Float64Array(this.fft.size);
    this.b = new Float64Array(this.fft.size);
    this.ar = new Float64Array(bins);
    this.ai = new Float64Array(bins);
    this.br = new Float64Array(bins);
    this.bi = new Float64Array(bins);
    this.r = new Float64Array(this.fft.size);
    this.d = new Float64Array(this.tauMax + 1);
    this.cmnd = new Float64Array(this.tauMax + 1);
  }

  /**
   * Estimates the frame whose span starts at `start` (samples outside `x` count as 0). Frames
   * whose mean square is below `silence` are unvoiced without running YIN.
   */
  estimate(x: Float32Array, start: number, silence = 0): void {
    const W = this.window;
    const tauMax = this.tauMax;
    const span = this.span;
    const a = this.a;
    const b = this.b;
    const n = x.length;
    let e0 = 0;
    for (let j = 0; j < span; j++) {
      const i = start + j;
      const v = i >= 0 && i < n ? (x[i] as number) : 0;
      b[j] = v;
      if (j < W) {
        a[j] = v;
        e0 += v * v;
      }
    }
    this.energy = e0 / W;
    this.f0 = 0;
    this.aperiodicity = 1;
    if (!(this.energy > silence) || !(e0 > 1e-20)) return;
    a.fill(0, W);
    b.fill(0, span);

    // r(τ) = Σ_{j<W} a[j]·b[j+τ] = IFFT(conj(A)·B)
    const fft = this.fft;
    fft.forward(a, this.ar, this.ai);
    fft.forward(b, this.br, this.bi);
    const ar = this.ar;
    const ai = this.ai;
    const br = this.br;
    const bi = this.bi;
    for (let k = 0; k < fft.bins; k++) {
      const xr = ar[k] as number;
      const xi = ai[k] as number;
      const yr = br[k] as number;
      const yi = bi[k] as number;
      ar[k] = xr * yr + xi * yi;
      ai[k] = xr * yi - xi * yr;
    }
    const r = this.r;
    fft.inverse(ar, ai, r);

    // d(τ) = e(0) + e(τ) − 2r(τ) with e(τ) = Σ_{j=τ}^{τ+W−1} b[j]², then the CMND.
    const d = this.d;
    const cmnd = this.cmnd;
    d[0] = 0;
    cmnd[0] = 1;
    let et = e0;
    let sum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      const out = b[tau - 1] as number;
      const inn = b[tau + W - 1] as number;
      et += inn * inn - out * out;
      const v = Math.max(0, e0 + et - 2 * (r[tau] as number));
      d[tau] = v;
      sum += v;
      cmnd[tau] = sum > 0 ? (v * tau) / sum : 1;
    }

    // Absolute threshold: first dip below it, then down to its local minimum; else the global minimum.
    const tauMin = this.tauMin;
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if ((cmnd[tau] as number) < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && (cmnd[tau + 1] as number) < (cmnd[tau] as number)) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      best = tauMin;
      for (let tau = tauMin + 1; tau <= tauMax; tau++) if ((cmnd[tau] as number) < (cmnd[best] as number)) best = tau;
    }
    let ap = cmnd[best] as number;
    // A minimum on the search boundary is not a real period (the dip continues outside the range).
    const onEdge =
      (best === tauMin && (cmnd[best - 1] as number) < ap) || (best === tauMax && (cmnd[best - 1] as number) > ap);
    // Parabolic interpolation of d(τ) around the minimum.
    let period = best;
    if (best > 1 && best < tauMax) {
      const y0 = d[best - 1] as number;
      const y1 = d[best] as number;
      const y2 = d[best + 1] as number;
      const den = y0 - 2 * y1 + y2;
      if (den > 0) {
        const shift = Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / den));
        period = best + shift;
        const c0 = cmnd[best - 1] as number;
        const c2 = cmnd[best + 1] as number;
        const cden = c0 - 2 * ap + c2;
        if (cden > 0) ap = Math.max(0, ap - (0.25 * (c0 - c2) * (c0 - c2)) / (2 * cden));
      }
    }
    this.aperiodicity = Math.min(1, ap);
    if (!onEdge && ap <= YIN_MAX_APERIODICITY) this.f0 = this.sampleRate / period;
  }
}

/**
 * Pitch track of a mono signal. Frames are centered at multiples of `hop`; unvoiced frames have
 * f0 = 0. Frames near the start and end read zeros beyond the signal.
 */
export function trackPitch(samples: Float32Array, sampleRate: number, opts: PitchOptions = {}): PitchTrack {
  const minHz = Math.max(1, opts.minHz ?? 40);
  const maxHz = Math.max(minHz * 2, opts.maxHz ?? 1000);
  const hop = Math.max(1, Math.round(opts.hop ?? sampleRate * 0.005));
  const n = samples.length;
  const frames = n > 0 && sampleRate > 0 ? Math.floor((n - 1) / hop) + 1 : 0;
  const times = new Float32Array(frames);
  const f0 = new Float32Array(frames);
  const confidence = new Float32Array(frames);
  if (frames === 0) return { times, f0, confidence };

  const k = pitchDecimation(sampleRate, maxHz);
  const rate = sampleRate / k;
  const x = decimate(sanitize(samples), k, sampleRate);
  const window = (opts.window ?? Math.max(sampleRate / minHz, sampleRate * 0.01)) / k;
  const yin = new Yin(rate, minHz, maxHz, window);

  // Silence floor relative to the loudest integration window (prefix sums of x²).
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = (prefix[i] as number) + (x[i] as number) * (x[i] as number);
  const meanSquare = (s: number): number => {
    const lo = Math.min(x.length, Math.max(0, s));
    const hi = Math.min(x.length, Math.max(0, s + yin.window));
    return ((prefix[hi] as number) - (prefix[lo] as number)) / yin.window;
  };
  const starts = new Int32Array(frames);
  let loudest = 0;
  for (let i = 0; i < frames; i++) {
    times[i] = (i * hop) / sampleRate;
    starts[i] = Math.round((i * hop) / k) - yin.lead;
    loudest = Math.max(loudest, meanSquare(starts[i] as number));
  }
  const silence = Math.max(SILENCE_RMS * SILENCE_RMS, loudest * Math.pow(10, -SILENCE_DB / 10));
  for (let i = 0; i < frames; i++) {
    yin.estimate(x, starts[i] as number, silence);
    f0[i] = yin.f0;
    confidence[i] = yin.energy > silence ? 1 - yin.aperiodicity : 0;
  }
  return { times, f0, confidence };
}

/** Copy with NaN/±Infinity replaced by 0. */
export function sanitize(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number;
    out[i] = v - v === 0 ? v : 0;
  }
  return out;
}
