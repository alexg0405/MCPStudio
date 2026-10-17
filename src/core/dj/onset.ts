/**
 * Onset strength for beat tracking: log-compressed spectral flux in four bands (kick, snare body,
 * snare crack / vocals, hats) on ~6 ms hops, each band whitened by its own spread so hats don't
 * drown the kick. Also keeps per-frame power (all and below 150 Hz) for the energy curve.
 * Pure TypeScript, no DOM; works at any analysis rate (22.05 kHz is what the app passes).
 *
 * `OnsetStream` takes the signal in pieces (a song of any length costs only its features); `onsetFeatures`
 * is the same for a signal that is in memory.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../voice/fft';
import { GrowF32, SlidingBuffer } from './sliding';

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
/** Samples of one piece the stream takes at a time (a longer piece is cut). */
const PIECE = 1 << 16;

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

/** The root mean square of a signal: the level the onset compression (and the chroma's) is scaled by. */
export function signalRms(x: ArrayLike<number>, n = x.length): number {
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (x[i] as number) * (x[i] as number);
  return Math.sqrt(sq / Math.max(1, n));
}

/**
 * `onsetFeatures` for a signal that arrives in pieces: a frame is computed as soon as the samples under it are in and only
 * the last 46 ms of the signal are kept, so a 2-hour song costs its features (about 35 MB at 22 kHz) and nothing more.
 * The compression is scaled by the signal's overall level (`rms`), which must be known when the stream starts: a whole
 * signal measures it, a streaming analysis measures a sample of the song (`stream-levels.ts`). `expectedSamples` sizes the
 * arrays (they grow if the signal turns out longer).
 */
export class OnsetStream {
  readonly frameRate: number;
  private readonly size: number;
  private readonly hop: number;
  private readonly fft: RealFFT;
  private readonly win: ArrayLike<number>;
  private readonly mag: Float64Array;
  private readonly gain: number;
  private readonly bandOf: Int8Array;
  private readonly binsIn = [0, 0, 0, 0];
  private readonly lowTop: number;
  // Log magnitudes of the last two frames (flux compares frames two hops apart: ~12 ms).
  private readonly prev2: Float64Array;
  private readonly prev1: Float64Array;
  private readonly flux = new Float64Array(4);
  private readonly bands: GrowF32[];
  private readonly power: GrowF32;
  private readonly lowPower: GrowF32;
  private readonly buf: SlidingBuffer;
  /** The next frame to compute. */
  private f = 0;
  private done = false;

  constructor(
    private readonly sampleRate: number,
    rms: number,
    expectedSamples = 0,
  ) {
    const size = nextPowerOfTwo(Math.round(0.046 * sampleRate));
    this.size = size;
    this.hop = size / 8;
    this.frameRate = sampleRate / this.hop;
    this.fft = new RealFFT(size);
    this.win = hannWindow(size);
    const bins = this.fft.bins;
    this.mag = new Float64Array(bins);
    // Level-independent compression: scale so the whole song has an RMS of 0.1.
    this.gain = rms > 1e-7 ? (0.1 / rms) * (4 / size) : 0;
    this.bandOf = new Int8Array(bins).fill(-1);
    for (let k = 1; k < bins; k++) {
      const f = (k * sampleRate) / size;
      for (let b = 0; b < 4; b++) if (f >= EDGES[b]! && f < EDGES[b + 1]!) this.bandOf[k] = b;
    }
    for (let k = 1; k < bins; k++) if (this.bandOf[k]! >= 0) this.binsIn[this.bandOf[k]!]!++;
    this.lowTop = Math.floor((150 * size) / sampleRate);
    this.prev2 = new Float64Array(bins);
    this.prev1 = new Float64Array(bins);
    const frames = Math.ceil(expectedSamples / this.hop) + 8;
    this.bands = [0, 1, 2, 3].map(() => new GrowF32(frames));
    this.power = new GrowF32(frames);
    this.lowPower = new GrowF32(frames);
    this.buf = new SlidingBuffer(size + PIECE);
  }

  /** Frames computed so far. */
  get frames(): number {
    return this.f;
  }

  /** Feeds the next samples of the signal. */
  push(x: Float32Array): void {
    if (this.done) throw new Error('The onset stream is finished.');
    for (let o = 0; o < x.length; o += PIECE) {
      this.buf.append(x.length <= PIECE ? x : x.subarray(o, Math.min(x.length, o + PIECE)));
      this.run(false);
    }
  }

  /** Computes the frames whose windows are in (`last`: the signal has ended, what is past its end is zeros). */
  private run(last: boolean): void {
    const { hop, buf } = this;
    const half = this.size / 2;
    const total = buf.end;
    const limit = last ? Math.ceil(total / hop) : Infinity;
    const view = buf.view();
    while (this.f < limit && (last || this.f * hop + half <= total)) {
      this.frame(view, this.f * hop - half - buf.base);
      this.f++;
    }
    // Forget what the next frame doesn't need.
    buf.discardBefore(this.f * hop - half);
  }

  private frame(samples: Float32Array, start: number): void {
    const { fft, win, mag, gain, bandOf, flux, prev1, prev2, lowTop } = this;
    magnitudeSpectrum(fft, samples, start, win, mag);
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
    // The difference over two hops peaks one hop early: file it under the frame between.
    const f = this.f;
    for (let b = 0; b < 4; b++) {
      const g = this.bands[b]!;
      g.push(0);
      if (f >= 2) g.data[f - 1] = flux[b]!;
    }
    this.power.push(p);
    this.lowPower.push(pl);
  }

  /** The end of the signal: the remaining frames, then the whitened features. */
  finish(): OnsetFeatures {
    if (!this.done) {
      this.run(true);
      this.done = true;
    }
    const frames = this.f;
    const bands = this.bands.map((g) => g.finish());
    // Whitening: subtract a local mean (~0.25 s) so sustained textures don't count, keep the rises,
    // then scale each band to unit spread.
    const half = Math.round((0.125 * this.sampleRate) / this.hop);
    const onset = new Float32Array(frames);
    for (let b = 0; b < 4; b++) {
      const x = bands[b]!;
      const mean = movingMean(x, half);
      for (let i = 0; i < frames; i++) x[i] = Math.max(0, x[i]! - mean[i]!);
      // A floor (per bin of the band) so a band with nothing happening isn't blown up to unit spread.
      const s = Math.max(spread(x), 0.003 * this.binsIn[b]!);
      if (s > 1e-9) for (let i = 0; i < frames; i++) x[i] = x[i]! / s;
      const w = WEIGHTS[b]!;
      for (let i = 0; i < frames; i++) onset[i] = onset[i]! + w * x[i]!;
    }
    return {
      frameRate: this.frameRate,
      onset,
      low: bands[0]!,
      lowMid: bands[1]!,
      highMid: bands[2]!,
      high: bands[3]!,
      power: this.power.finish(),
      lowPower: this.lowPower.finish(),
    };
  }
}

export function onsetFeatures(
  mono: Float32Array,
  sampleRate: number,
  progress?: (fraction: number) => void,
): OnsetFeatures {
  const stream = new OnsetStream(sampleRate, signalRms(mono), mono.length);
  const step = Math.max(1, Math.floor(mono.length / 20 / PIECE)) * PIECE;
  for (let o = 0; o < mono.length; o += step) {
    stream.push(mono.subarray(o, Math.min(mono.length, o + step)));
    progress?.(Math.min(1, (o + step) / mono.length));
  }
  return stream.finish();
}
