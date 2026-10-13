// State-variable filter, Andrew Simper's (Cytomic) trapezoidal "linear trap optimised" form.
// Stable under fast cutoff modulation, unlike a biquad. Allocation-free; usable on any thread.

export type SvfType =
  'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peak' | 'allpass' | 'bell' | 'lowshelf' | 'highshelf';

/**
 * 12 dB/octave multimode filter. `set()` computes the coefficients (cheap enough to call per block,
 * or per sample while sweeping); `process()` returns the chosen response and leaves the three core
 * outputs in `low`, `band` and `high` for multimode use.
 */
export class Svf {
  /** Low-pass output of the last `process()`. */
  low = 0;
  /** Band-pass output (unity gain at the centre): `low + band + high` is the input. */
  band = 0;
  /** High-pass output. */
  high = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private k = 1.414;
  private m0 = 0;
  private m1 = 0;
  private m2 = 1;
  private ic1 = 0;
  private ic2 = 0;

  /** `gainDb` is used by the bell and shelf types only. `q` 0.707 = Butterworth. */
  set(type: SvfType, freq: number, q: number, sampleRate: number, gainDb = 0): this {
    const f = Math.min(Math.max(freq, 1), sampleRate * 0.49);
    const qq = Math.max(q, 1e-3);
    const A = Math.pow(10, gainDb / 40);
    let g = Math.tan((Math.PI * f) / sampleRate);
    let k = 1 / qq;
    let m0 = 0;
    let m1 = 0;
    let m2 = 1;
    switch (type) {
      case 'lowpass':
        break;
      case 'bandpass':
        m1 = k;
        m2 = 0;
        break;
      case 'highpass':
        m0 = 1;
        m1 = -k;
        m2 = -1;
        break;
      case 'notch':
        m0 = 1;
        m1 = -k;
        m2 = 0;
        break;
      case 'peak':
        m0 = 1;
        m1 = -k;
        m2 = -2;
        break;
      case 'allpass':
        m0 = 1;
        m1 = -2 * k;
        m2 = 0;
        break;
      case 'bell':
        k = 1 / (qq * A);
        m0 = 1;
        m1 = k * (A * A - 1);
        m2 = 0;
        break;
      case 'lowshelf':
        g /= Math.sqrt(A);
        m0 = 1;
        m1 = k * (A - 1);
        m2 = A * A - 1;
        break;
      case 'highshelf':
        g *= Math.sqrt(A);
        m0 = A * A;
        m1 = k * (1 - A) * A;
        m2 = 1 - A * A;
        break;
    }
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    this.m0 = m0;
    this.m1 = m1;
    this.m2 = m2;
    return this;
  }

  process(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    let s1 = 2 * v1 - this.ic1;
    let s2 = 2 * v2 - this.ic2;
    // Flush denormals (and NaN) in the integrator states.
    if (!(Math.abs(s1) > 1e-20)) s1 = 0;
    if (!(Math.abs(s2) > 1e-20)) s2 = 0;
    this.ic1 = s1;
    this.ic2 = s2;
    this.low = v2;
    this.band = this.k * v1;
    this.high = x - this.k * v1 - v2;
    return this.m0 * x + this.m1 * v1 + this.m2 * v2;
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
    this.low = 0;
    this.band = 0;
    this.high = 0;
  }
}
