/**
 * Radix-2 FFTs for analysis code (voice analysis, spectra). Pure TypeScript, no DOM. Every
 * transform object precomputes its tables once and allocates nothing per call, so one instance
 * can be reused across the frames of an STFT.
 *
 * Conventions: forward X[k] = Σ x[n]·e^(−2πikn/N); inverse is scaled by 1/N, so
 * inverse(forward(x)) = x.
 */

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
}

/** Smallest power of two ≥ n (1 for n ≤ 1). */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** In-place iterative radix-2 complex FFT of one fixed size (any power of two, including 1). */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  /** cos/sin(2πk/N) for k < N/2. */
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size)) throw new RangeError(`FFT size must be a power of two (got ${size}).`);
    this.size = size;
    this.rev = new Uint32Array(size);
    const bits = Math.round(Math.log2(size));
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / size);
      this.sin[k] = Math.sin((2 * Math.PI * k) / size);
    }
  }

  /** Forward transform in place. */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, -1);
  }

  /** Inverse transform in place, scaled by 1/N. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, 1);
    const n = this.size;
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) * s;
      im[i] = (im[i] as number) * s;
    }
  }

  /** Unscaled transform with e^(sign·2πikn/N). */
  private transform(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
    const n = this.size;
    if (re.length < n || im.length < n) throw new RangeError('FFT input is shorter than the transform size.');
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i] as number;
      if (j > i) {
        const tr = re[i] as number;
        re[i] = re[j] as number;
        re[j] = tr;
        const ti = im[i] as number;
        im[i] = im[j] as number;
        im[j] = ti;
      }
    }
    // Length-2 butterflies need no twiddles.
    for (let i = 0; i + 1 < n; i += 2) {
      const ar = re[i] as number;
      const ai = im[i] as number;
      const br = re[i + 1] as number;
      const bi = im[i + 1] as number;
      re[i] = ar + br;
      im[i] = ai + bi;
      re[i + 1] = ar - br;
      im[i + 1] = ai - bi;
    }
    const cos = this.cos;
    const sin = this.sin;
    for (let len = 4; len <= n; len <<= 1) {
      const half = len >> 1;
      const stride = n / len;
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride] as number;
        const wi = sign * (sin[k * stride] as number);
        for (let a = k; a < n; a += len) {
          const b = a + half;
          const br = re[b] as number;
          const bi = im[b] as number;
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          const ar = re[a] as number;
          const ai = im[a] as number;
          re[b] = ar - xr;
          im[b] = ai - xi;
          re[a] = ar + xr;
          im[a] = ai + xi;
        }
      }
    }
  }
}

/**
 * FFT of real input (size N, a power of two ≥ 2), computed with one complex FFT of size N/2.
 * Spectra are the N/2 + 1 non-negative frequency bins; the rest follow from X[N−k] = conj(X[k]).
 */
export class RealFFT {
  readonly size: number;
  /** Number of spectrum bins: size / 2 + 1. */
  readonly bins: number;
  /** Work buffers owned by this transform (helpers such as `magnitudeSpectrum` use them). */
  readonly frame: Float64Array;
  readonly re: Float64Array;
  readonly im: Float64Array;
  private readonly half: FFT;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  /** cos/sin(2πk/N) for k ≤ N/2. */
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size) || size < 2) throw new RangeError(`RealFFT size must be a power of two ≥ 2 (got ${size}).`);
    this.size = size;
    const m = size >> 1;
    this.bins = m + 1;
    this.half = new FFT(m);
    this.zr = new Float64Array(m);
    this.zi = new Float64Array(m);
    this.frame = new Float64Array(size);
    this.re = new Float64Array(m + 1);
    this.im = new Float64Array(m + 1);
    this.cos = new Float64Array(m + 1);
    this.sin = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / size);
      this.sin[k] = Math.sin((2 * Math.PI * k) / size);
    }
  }

  /** Spectrum of x[0..size) (x may be longer; the rest is ignored) into re/im[0..size/2]. */
  forward(x: ArrayLike<number>, re: Float64Array, im: Float64Array): void {
    const m = this.size >> 1;
    if (x.length < this.size) throw new RangeError('RealFFT input is shorter than the transform size.');
    if (re.length < m + 1 || im.length < m + 1) throw new RangeError('RealFFT output needs size/2 + 1 bins.');
    const zr = this.zr;
    const zi = this.zi;
    for (let i = 0; i < m; i++) {
      zr[i] = x[2 * i] as number;
      zi[i] = x[2 * i + 1] as number;
    }
    this.half.forward(zr, zi);
    // Split Z = FFT(even + i·odd) into E (even samples) and O (odd samples): X[k] = E[k] + W^k·O[k].
    const z0r = zr[0] as number;
    const z0i = zi[0] as number;
    re[0] = z0r + z0i;
    im[0] = 0;
    re[m] = z0r - z0i;
    im[m] = 0;
    const cos = this.cos;
    const sin = this.sin;
    for (let k = 1; k < m; k++) {
      const a = zr[k] as number;
      const b = zi[k] as number;
      const c = zr[m - k] as number;
      const d = zi[m - k] as number;
      const er = (a + c) * 0.5;
      const ei = (b - d) * 0.5;
      const or = (b + d) * 0.5;
      const oi = (c - a) * 0.5;
      const wr = cos[k] as number;
      const ws = sin[k] as number; // W^k = wr − i·ws
      re[k] = er + wr * or + ws * oi;
      im[k] = ei + wr * oi - ws * or;
    }
  }

  /** Real signal of a Hermitian spectrum given by bins re/im[0..size/2], scaled so inverse(forward(x)) = x. */
  inverse(re: ArrayLike<number>, im: ArrayLike<number>, x: Float64Array | Float32Array): void {
    const m = this.size >> 1;
    if (re.length < m + 1 || im.length < m + 1) throw new RangeError('RealFFT spectrum needs size/2 + 1 bins.');
    if (x.length < this.size) throw new RangeError('RealFFT output is shorter than the transform size.');
    const zr = this.zr;
    const zi = this.zi;
    const cos = this.cos;
    const sin = this.sin;
    for (let k = 0; k < m; k++) {
      const xr = re[k] as number;
      const xi = im[k] as number;
      // conj(X[m − k])
      const yr = re[m - k] as number;
      const yi = -(im[m - k] as number);
      const er = (xr + yr) * 0.5;
      const ei = (xi + yi) * 0.5;
      // O = (X − conj(X[m−k]))·W^(−k) / 2, W^(−k) = cos + i·sin
      const dr = (xr - yr) * 0.5;
      const di = (xi - yi) * 0.5;
      const wr = cos[k] as number;
      const ws = sin[k] as number;
      const or = dr * wr - di * ws;
      const oi = dr * ws + di * wr;
      // Z = E + i·O
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this.half.inverse(zr, zi);
    for (let i = 0; i < m; i++) {
      x[2 * i] = zr[i] as number;
      x[2 * i + 1] = zi[i] as number;
    }
  }
}

/**
 * Hann window. Periodic by default (w[i] = 0.5 − 0.5·cos(2πi/N), the right choice for spectral
 * analysis with overlapping frames); `symmetric` uses N − 1 in the denominator (filter design).
 */
export function hannWindow(length: number, symmetric = false): Float64Array {
  const w = new Float64Array(Math.max(0, Math.floor(length)));
  const n = w.length;
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const d = symmetric ? n - 1 : n;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

/**
 * Magnitude spectrum |X[k]| (k = 0..size/2) of samples[start + i]·window[i] for i < window.length,
 * zero-padded to `fft.size`. Samples outside the array count as 0, so frames may hang over either
 * end. With `power`, writes |X[k]|² instead. Uses the FFT's own work buffers; allocates nothing.
 */
export function magnitudeSpectrum(
  fft: RealFFT,
  samples: ArrayLike<number>,
  start: number,
  window: ArrayLike<number>,
  out: Float32Array | Float64Array,
  power = false,
): void {
  const frame = fft.frame;
  const len = Math.min(window.length, fft.size);
  // In-range part [i0, i1) without per-sample bounds checks.
  const i0 = Math.min(len, Math.max(0, -start));
  const i1 = Math.max(i0, Math.min(len, samples.length - start));
  frame.fill(0, 0, i0);
  for (let i = i0; i < i1; i++) frame[i] = (samples[start + i] as number) * (window[i] as number);
  frame.fill(0, i1);
  fft.forward(frame, fft.re, fft.im);
  const re = fft.re;
  const im = fft.im;
  const bins = Math.min(fft.bins, out.length);
  if (power) {
    for (let k = 0; k < bins; k++)
      out[k] = (re[k] as number) * (re[k] as number) + (im[k] as number) * (im[k] as number);
  } else {
    for (let k = 0; k < bins; k++)
      out[k] = Math.sqrt((re[k] as number) * (re[k] as number) + (im[k] as number) * (im[k] as number));
  }
}
