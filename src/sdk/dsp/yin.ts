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
  private readonly frame: Float32Array;
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
    this.frame = new Float32Array(size);
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
    const n = this.ring.length;
    if (this.filled < n) return this.unvoiced(0);
    const x = this.frame;
    // Oldest first.
    for (let i = 0, j = this.pos; i < n; i++, j = j + 1 < n ? j + 1 : 0) x[i] = this.ring[j] as number;
    const w = this.window;
    let energy = 0;
    for (let j = 0; j < w; j++) energy += (x[j] as number) * (x[j] as number);
    if (Math.sqrt(energy / w) < SILENCE_RMS) return this.unvoiced(0);
    // Difference function and its cumulative mean normalization (d'(0) = 1).
    const d = this.diff;
    const raw = this.raw;
    const maxLag = this.maxLag;
    d[0] = 1;
    raw[0] = 0;
    let sum = 0;
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      let acc = 0;
      for (let j = 0; j < w; j++) {
        const delta = (x[j] as number) - (x[j + tau] as number);
        acc += delta * delta;
      }
      sum += acc;
      raw[tau] = acc;
      d[tau] = sum > 0 ? (acc * tau) / sum : 1;
    }
    // The first dip under the threshold (then down to its bottom), else the deepest one.
    let best = -1;
    for (let tau = this.minLag; tau <= maxLag; tau++) {
      if ((d[tau] as number) < this.threshold) {
        while (tau + 1 <= maxLag && (d[tau + 1] as number) < (d[tau] as number)) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let min = Infinity;
      for (let tau = this.minLag; tau <= maxLag; tau++) {
        if ((d[tau] as number) < min) {
          min = d[tau] as number;
          best = tau;
        }
      }
      if (min > this.maxAperiodicity) return this.unvoiced(1 - min);
    }
    // Parabolic interpolation of the raw difference around the dip (less biased than d').
    const a = raw[best - 1] as number;
    const b = raw[best] as number;
    const c = raw[best + 1] as number;
    const den = a - 2 * b + c;
    const shift = den > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0;
    this.frequency = this.analysisRate / (best + shift);
    this.confidence = Math.max(0, Math.min(1, 1 - (d[best] as number)));
    return this.frequency;
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
