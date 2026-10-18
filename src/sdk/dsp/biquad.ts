// RBJ "Audio EQ Cookbook" biquad, transposed direct form II. Allocation-free; usable on any thread.

/** The filter shapes of the cookbook. `peaking` and the two shelves use the gain; the others ignore it. */
export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf' | 'notch';

/** Highest centre frequency, as a share of the sample rate (a hair under Nyquist, where the design breaks down). */
const MAX_FREQ_SHARE = 0.49;
/** Smallest Q (keeps the bandwidth finite). */
const MIN_Q = 1e-4;
/** Below this the feedback state is flushed to zero, so silence never runs on denormal numbers. */
const DENORMAL_FLOOR = 1e-20;

/**
 * A second-order filter section with RBJ's coefficients. `set()` designs it (cheap enough to call
 * every block, or every sample while sweeping), `process()` filters one sample.
 */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  /**
   * Designs the filter: `freq` in Hz (kept between 1 Hz and just under Nyquist), `q` (0.707 =
   * Butterworth), `gainDb` for the peaking and shelf types only.
   *
   * The switch is the cookbook's table of coefficients, name for name (w0 is the centre in radians
   * per sample, alpha the bandwidth term, A the amplitude of the gain). It stays one function on
   * purpose: designs are redone per sample while sweeping, and splitting the table into helper
   * calls made `set` about 20 % slower.
   */
  set(type: BiquadType, freq: number, q: number, sampleRate: number, gainDb = 0): this {
    const f = Math.min(Math.max(freq, 1), sampleRate * MAX_FREQ_SHARE);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * Math.max(q, MIN_Q));
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1;
        b1 = -2 * cos;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A;
        b1 = -2 * cos;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos;
        a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const shelfTerm = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cos + shelfTerm);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - shelfTerm);
        a0 = A + 1 + (A - 1) * cos + shelfTerm;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - shelfTerm;
        break;
      }
      case 'highshelf': {
        const shelfTerm = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cos + shelfTerm);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - shelfTerm);
        a0 = A + 1 - (A - 1) * cos + shelfTerm;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - shelfTerm;
        break;
      }
    }
    // The cookbook divides everything by a0 so `process` needs no division.
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  /** Filters one sample. */
  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    // Flush denormals in the feedback state.
    if (!(Math.abs(this.z1) > DENORMAL_FLOOR)) this.z1 = 0;
    if (!(Math.abs(this.z2) > DENORMAL_FLOOR)) this.z2 = 0;
    return y;
  }

  /** Clears the filter's memory (a silent start). */
  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}
