// Fast Fourier transform and a stereo power spectrum for meters. Allocation-free after construction;
// usable on any thread.

/** In-place radix-2 FFT of a power-of-two size, with its tables made once. */
export class Fft {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(readonly size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two (at least 4)');
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.round(Math.log2(size));
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform of (re, im), in place: X[k] = Σ x[n]·e^(−2πikn/N). */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size;
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
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = this.cos[t] as number;
          const wi = this.sin[t] as number;
          const a = start + k;
          const b = a + half;
          const xr = (re[b] as number) * wr - (im[b] as number) * wi;
          const xi = (re[b] as number) * wi + (im[b] as number) * wr;
          re[b] = (re[a] as number) - xr;
          im[b] = (im[a] as number) - xi;
          re[a] = (re[a] as number) + xr;
          im[a] = (im[a] as number) + xi;
        }
      }
    }
  }
}

/**
 * The power spectrum of a stereo signal, refreshed every `hop` frames from the last `size` frames (Hann window).
 * One complex transform serves both channels (left in the real part, right in the imaginary part), and the result
 * is the mean of the two channels' power, per bin `k` (frequency `k · sampleRate / size`), scaled so a sine at full
 * scale in both channels reads 1 in its bin (and 0.5 when only one channel has it).
 */
export class StereoSpectrum {
  /** Linear power per bin, 0 to size/2 − 1. */
  readonly power: Float32Array;
  private readonly fft: Fft;
  private readonly ringL: Float32Array;
  private readonly ringR: Float32Array;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly norm: number;
  private pos = 0;
  private fresh = 0;

  constructor(
    readonly size: number,
    readonly hop: number,
  ) {
    this.fft = new Fft(size);
    this.power = new Float32Array(size / 2);
    this.ringL = new Float32Array(size);
    this.ringR = new Float32Array(size);
    this.window = new Float64Array(size);
    for (let i = 0; i < size; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    const peak = size / 4;
    this.norm = 1 / (4 * peak * peak);
  }

  /** Feeds frames; returns how many spectra were refreshed (`power` holds the latest). */
  push(left: Float32Array, right: Float32Array, n: number): number {
    let done = 0;
    const size = this.size;
    for (let i = 0; i < n; i++) {
      this.ringL[this.pos] = left[i] as number;
      this.ringR[this.pos] = right[i] as number;
      this.pos = this.pos + 1 === size ? 0 : this.pos + 1;
      if (++this.fresh >= this.hop) {
        this.fresh = 0;
        this.compute();
        done++;
      }
    }
    return done;
  }

  reset(): void {
    this.ringL.fill(0);
    this.ringR.fill(0);
    this.power.fill(0);
    this.pos = 0;
    this.fresh = 0;
  }

  private compute(): void {
    const size = this.size;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < size; i++) {
      const at = (this.pos + i) % size;
      const w = this.window[i] as number;
      re[i] = (this.ringL[at] as number) * w;
      im[i] = (this.ringR[at] as number) * w;
    }
    this.fft.forward(re, im);
    const bins = size / 2;
    const norm = this.norm;
    for (let k = 0; k < bins; k++) {
      const m = k === 0 ? 0 : size - k;
      const a = (re[k] as number) ** 2 + (im[k] as number) ** 2;
      const b = (re[m] as number) ** 2 + (im[m] as number) ** 2;
      this.power[k] = (a + b) * norm;
    }
  }
}
