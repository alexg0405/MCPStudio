// Real-time YIN pitch detector. Allocation-free after construction; usable on any thread.
import { Svf } from './svf';

export interface YinOptions {
  /** Lowest fundamental to look for, Hz (default 60). */
  minHz?: number;
  /** Highest fundamental to look for, Hz (default 1000). */
  maxHz?: number;
  /** YIN's absolute threshold: the first dip of the normalized difference below it is the period (default 0.15). */
  threshold?: number;
  /** Frames whose best dip stays above this are unvoiced (default 0.35). */
  maxAperiodicity?: number;
}

/** Lowest analysis rate after decimation (enough for fundamentals up to 1 kHz). */
const MIN_ANALYSIS_RATE = 8000;
/** RMS below this counts as silence (−80 dBFS). */
const SILENCE_RMS = 1e-4;

/**
 * Monophonic pitch tracking with YIN (de Cheveigné & Kawahara, 2002): difference function,
 * cumulative mean normalized difference, absolute threshold and parabolic interpolation, on a
 * decimated copy of the input (≥ 8 kHz, with an anti-alias filter).
 *
 * `push()` every input sample; call `detect()` whenever you want a new estimate (every 5–10 ms is
 * typical: each call costs about window × maxLag multiply-adds). It reads the most recent window
 * and leaves its result in `frequency` (Hz, 0 when unvoiced or silent) and `confidence` (0–1).
 */
export class Yin {
  /** Rate the detector analyses at (the input rate divided by `decimation`). */
  readonly analysisRate: number;
  readonly decimation: number;
  /** Last estimate in Hz; 0 = no clear pitch (noise, silence, chords). */
  frequency = 0;
  /** 1 − the normalized difference at the chosen period (1 = perfectly periodic). */
  confidence = 0;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly window: number;
  private readonly ring: Float32Array;
  private readonly frame: Float64Array;
  private readonly diff: Float32Array;
  /** The raw difference function (interpolated for sub-sample accuracy). */
  private readonly raw: Float32Array;
  private readonly threshold: number;
  private readonly maxAperiodicity: number;
  private readonly aa1 = new Svf();
  private readonly aa2 = new Svf();
  private pos = 0;
  private phase = 0;
  private filled = 0;
  /** The difference function is valid up to this lag, and `sum` is its running total, in the current detect(). */
  private done = 0;
  private sum = 0;

  constructor(
    readonly sampleRate: number,
    opts: YinOptions = {},
  ) {
    const minHz = Math.max(20, opts.minHz ?? 60);
    const maxHz = Math.max(minHz * 2, opts.maxHz ?? 1000);
    this.decimation = Math.max(1, Math.floor(sampleRate / Math.max(MIN_ANALYSIS_RATE, 8 * maxHz)));
    this.analysisRate = sampleRate / this.decimation;
    this.minLag = Math.max(2, Math.floor(this.analysisRate / maxHz));
    this.maxLag = Math.ceil(this.analysisRate / minHz);
    // Integration window: one period of the lowest pitch, at least 10 ms.
    this.window = Math.max(this.maxLag, Math.ceil(this.analysisRate * 0.01));
    const size = this.window + this.maxLag + 2;
    this.ring = new Float32Array(size);
    this.frame = new Float64Array(size);
    this.diff = new Float32Array(this.maxLag + 2);
    this.raw = new Float32Array(this.maxLag + 2);
    this.threshold = opts.threshold ?? 0.15;
    this.maxAperiodicity = opts.maxAperiodicity ?? 0.35;
    const cutoff = Math.min(0.45 * this.analysisRate, 2.5 * maxHz);
    this.aa1.set('lowpass', cutoff, 0.5411961, sampleRate);
    this.aa2.set('lowpass', cutoff, 1.30656296, sampleRate);
  }

  /** Samples of input (at the input rate) the analysis spans. */
  get span(): number {
    return (this.window + this.maxLag) * this.decimation;
  }

  /** Feeds one input sample. */
  push(x: number): void {
    const y = this.aa2.process(this.aa1.process(x));
    if (++this.phase < this.decimation) return;
    this.phase = 0;
    this.ring[this.pos] = y;
    this.pos = this.pos + 1 < this.ring.length ? this.pos + 1 : 0;
    if (this.filled < this.ring.length) this.filled++;
  }

  /** Estimates the pitch of the latest window; returns `frequency`. */
  detect(): number {
    if (this.filled < this.ring.length) return this.unvoiced(0);
    this.copyWindowOldestFirst();
    const x = this.frame;
    const w = this.window;
    if (this.rmsOf(x, w) < SILENCE_RMS) return this.unvoiced(0);
    // Difference function and its cumulative mean normalization (d'(0) = 1), lag by lag and only as far
    // as the search reads: the first dip under the threshold usually comes well before the longest lag.
    const d = this.diff;
    d[0] = 1;
    this.raw[0] = 0;
    this.done = 0;
    this.sum = 0;
    let bestLag = this.firstDipLag(x, w);
    if (bestLag < 0) {
      bestLag = this.deepestDipLag(x, w);
      const depth = bestLag < 0 ? Infinity : (d[bestLag] as number);
      if (depth > this.maxAperiodicity) return this.unvoiced(1 - depth);
    }
    this.frequency = this.analysisRate / (bestLag + this.parabolicShift(x, w, bestLag));
    this.confidence = Math.max(0, Math.min(1, 1 - (d[bestLag] as number)));
    return this.frequency;
  }

  /** Copies the ring into `frame`, the oldest sample first. */
  private copyWindowOldestFirst(): void {
    const n = this.ring.length;
    const x = this.frame;
    for (let i = 0, j = this.pos; i < n; i++, j = j + 1 < n ? j + 1 : 0) x[i] = this.ring[j] as number;
  }

  /** Root mean square of the first `w` samples of `x`. */
  private rmsOf(x: Float64Array, w: number): number {
    let energy = 0;
    for (let j = 0; j < w; j++) energy += (x[j] as number) * (x[j] as number);
    return Math.sqrt(energy / w);
  }

  /** The first lag whose normalized difference is under the threshold, followed down to the bottom of its dip; -1 when none. */
  private firstDipLag(x: Float64Array, w: number): number {
    const d = this.diff;
    const maxLag = this.maxLag;
    for (let tau = this.minLag; tau <= maxLag; tau++) {
      this.lagsTo(x, w, tau);
      if (!((d[tau] as number) < this.threshold)) continue;
      for (;;) {
        if (tau + 1 > maxLag) break;
        this.lagsTo(x, w, tau + 1);
        if (!((d[tau + 1] as number) < (d[tau] as number))) break;
        tau++;
      }
      return tau;
    }
    return -1;
  }

  /** The lag with the smallest normalized difference (the first, on a tie); -1 when none is comparable. */
  private deepestDipLag(x: Float64Array, w: number): number {
    const d = this.diff;
    this.lagsTo(x, w, this.maxLag);
    let lowest = Infinity;
    let bestLag = -1;
    for (let tau = this.minLag; tau <= this.maxLag; tau++) {
      if ((d[tau] as number) < lowest) {
        lowest = d[tau] as number;
        bestLag = tau;
      }
    }
    return bestLag;
  }

  /**
   * Parabolic interpolation of the raw difference around the dip at `bestLag` (less biased than d'):
   * how far, from -0.5 to 0.5 lags, the true minimum lies from it.
   */
  private parabolicShift(x: Float64Array, w: number, bestLag: number): number {
    const raw = this.raw;
    this.lagsTo(x, w, bestLag + 1);
    const before = raw[bestLag - 1] as number;
    const at = raw[bestLag] as number;
    const after = raw[bestLag + 1] as number;
    const curvature = before - 2 * at + after;
    return curvature > 0 ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * curvature))) : 0;
  }

  /** Extends the difference function (and the raw one) of the window `x` (length `w`) to lag `to`. */
  private lagsTo(x: Float64Array, w: number, to: number): void {
    const d = this.diff;
    const raw = this.raw;
    for (let tau = this.done + 1; tau <= to; tau++) {
      // Four partial sums: one running sum would wait on each add in turn.
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      let j = 0;
      for (; j + 3 < w; j += 4) {
        const d0 = (x[j] as number) - (x[j + tau] as number);
        const d1 = (x[j + 1] as number) - (x[j + 1 + tau] as number);
        const d2 = (x[j + 2] as number) - (x[j + 2 + tau] as number);
        const d3 = (x[j + 3] as number) - (x[j + 3 + tau] as number);
        a0 += d0 * d0;
        a1 += d1 * d1;
        a2 += d2 * d2;
        a3 += d3 * d3;
      }
      for (; j < w; j++) {
        const delta = (x[j] as number) - (x[j + tau] as number);
        a0 += delta * delta;
      }
      const acc = a0 + a1 + (a2 + a3);
      this.sum += acc;
      raw[tau] = acc;
      d[tau] = this.sum > 0 ? (acc * tau) / this.sum : 1;
    }
    if (to > this.done) this.done = to;
  }

  reset(): void {
    this.ring.fill(0);
    this.pos = 0;
    this.phase = 0;
    this.filled = 0;
    this.frequency = 0;
    this.confidence = 0;
    this.aa1.reset();
    this.aa2.reset();
  }

  private unvoiced(confidence: number): number {
    this.frequency = 0;
    this.confidence = Math.max(0, confidence);
    return 0;
  }
}
