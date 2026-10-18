/**
 * The spectrum bars of the music video, computed from rendered audio (not from a live analyser):
 * a Hann-windowed FFT around the frame's moment, grouped into log-spaced bands, in dB, tilted a
 * little so highs show like they do on any visualizer, scaled to 0…1 and smoothed (quick to rise,
 * slow to fall). The state is only the previous frame's bars, so frames must be asked in order;
 * the same audio always gives the same bars.
 */
import { RealFFT, hannWindow, magnitudeSpectrum } from '../voice/fft';

export interface SpectrumOptions {
  fftSize?: number;
  /** Lowest and highest band edge, Hz. */
  lo?: number;
  hi?: number;
  /** dBFS that draws as a full bar, and the range below it that draws as a bar at all. */
  topDb?: number;
  rangeDb?: number;
}

/** Edges (Hz) of `bands` log-spaced bands from lo to hi: bands + 1 numbers. */
export function bandEdges(bands: number, lo: number, hi: number): Float64Array {
  const e = new Float64Array(bands + 1);
  for (let i = 0; i <= bands; i++) e[i] = lo * Math.pow(hi / lo, i / bands);
  return e;
}

export class SpectrumAnalyzer {
  readonly bands: number;
  readonly fftSize: number;
  /** The smoothed bars, 0…1 (the same array every call). */
  readonly bars: Float32Array;
  /** Loudness of the window, 0…1 (RMS in dB: −40 dBFS and below reads 0, −4 dBFS and above reads 1). */
  level = 0;
  private readonly fft: RealFFT;
  private readonly window: Float64Array;
  private readonly mags: Float32Array;
  private readonly edges: Float64Array;
  /** Amplitude scale: a full-scale sine reads 0 dBFS in its bin. */
  private readonly norm: number;
  private readonly topDb: number;
  private readonly rangeDb: number;
  private readonly hzPerBin: number;
  private readonly tilt: Float64Array;

  constructor(
    readonly sampleRate: number,
    bands: number,
    opts: SpectrumOptions = {},
  ) {
    this.bands = bands;
    this.fftSize = opts.fftSize ?? 4096;
    this.fft = new RealFFT(this.fftSize);
    this.window = hannWindow(this.fftSize);
    this.mags = new Float32Array(this.fft.bins);
    const lo = opts.lo ?? 40;
    const hi = Math.min(opts.hi ?? 16000, sampleRate / 2 - 100);
    this.edges = bandEdges(bands, lo, hi);
    let sum = 0;
    for (let i = 0; i < this.window.length; i++) sum += this.window[i] as number;
    this.norm = 2 / sum;
    this.topDb = opts.topDb ?? -14;
    this.rangeDb = opts.rangeDb ?? 58;
    this.hzPerBin = sampleRate / this.fftSize;
    this.bars = new Float32Array(bands);
    // +3 dB per octave above 1 kHz and below: pink-ish music reads flat across the bars.
    this.tilt = new Float64Array(bands);
    for (let b = 0; b < bands; b++) {
      const centre = Math.sqrt((this.edges[b] as number) * (this.edges[b + 1] as number));
      this.tilt[b] = 3 * Math.log2(centre / 1000);
    }
  }

  /**
   * The bars for the sound in `samples` (a mono window of `fftSize` samples centred on the frame's moment).
   * `dt`: seconds since the previous frame, for the smoothing (0: no smoothing, take the new bars as they are).
   */
  process(samples: Float32Array, dt: number): Float32Array {
    magnitudeSpectrum(this.fft, samples, 0, this.window, this.mags);
    const mags = this.mags;
    const top = mags.length - 1;
    const release = dt > 0 ? 1 - Math.exp(-dt / 0.14) : 1;
    for (let b = 0; b < this.bands; b++) {
      const f0 = (this.edges[b] as number) / this.hzPerBin;
      const f1 = (this.edges[b + 1] as number) / this.hzPerBin;
      let m: number;
      if (f1 - f0 >= 1) {
        const k0 = Math.max(1, Math.floor(f0 + 0.5));
        const k1 = Math.min(top, Math.max(k0, Math.floor(f1 - 0.5)));
        m = 0;
        for (let k = k0; k <= k1; k++) m = Math.max(m, mags[k] as number);
      } else {
        // Narrower than a bin: interpolate between the bins around the band's centre.
        const f = Math.min(top - 1, (f0 + f1) / 2);
        const k = Math.max(0, Math.floor(f));
        const frac = f - k;
        m = (mags[k] as number) * (1 - frac) + (mags[k + 1] as number) * frac;
      }
      const db = 20 * Math.log10(m * this.norm + 1e-9) + (this.tilt[b] as number);
      const raw = Math.min(1, Math.max(0, (db - this.topDb + this.rangeDb) / this.rangeDb));
      const prev = this.bars[b] as number;
      // Rise at once (a kick must land on its frame), fall slowly.
      this.bars[b] = raw >= prev ? raw : prev + (raw - prev) * release;
    }
    // Level: RMS of the middle of the window.
    const n = Math.min(samples.length, 1024);
    const from = (samples.length - n) >> 1;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[from + i] as number;
      acc += v * v;
    }
    const rms = Math.sqrt(acc / Math.max(1, n));
    const level = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 40) / 36));
    this.level = level >= this.level ? level : this.level + (level - this.level) * release;
    return this.bars;
  }

  /** Forget the previous frame (a jump in time). */
  reset(): void {
    this.bars.fill(0);
    this.level = 0;
  }
}
