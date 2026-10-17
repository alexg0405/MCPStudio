/**
 * Chromagram for key detection and harmonic change: spectral peaks from 27 Hz to 2 kHz (the bass at
 * ~2.8 kHz with 740 ms frames, the rest at ~11 kHz with 370 ms frames, both on 93 ms hops) mapped to
 * pitch classes after estimating the song's tuning (how far its notes sit from A = 440 Hz), weighted
 * by compressed magnitude, overtones of lower notes counting little. Bass (below 200 Hz) and treble
 * are kept apart: the bass says most about the tonic. Pure TypeScript, no DOM.
 *
 * `ChromaStream` takes the signal in pieces (the peaks of a whole song are kept, 9 bytes each, because the tuning
 * is only known at the end; everything else is forgotten as it is used); `chromagram` is the same for a signal that
 * is in memory.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../voice/fft';
import { Decimator } from '../voice/filters';
import { BlockedF32, BlockedU8, GrowF32, SlidingBuffer } from './sliding';

export interface Chromagram {
  /** Frames per second; frame f is centred on f / frameRate seconds. */
  frameRate: number;
  frames: number;
  /** 12 values per frame (C … B), frame after frame: treble (200 Hz–2 kHz) and bass (27–200 Hz). */
  treble: Float32Array;
  bass: Float32Array;
  /** Tonal energy per frame (sum of peak weights). */
  energy: Float32Array;
  /** Tuning of the song in cents from A = 440 Hz (−50…50). */
  tuningCents: number;
}

/** Spectral peaks of one frame between two frequencies (rising), as (Hz, magnitude) pairs. */
function framePeaks(mag: Float64Array, binHz: number, fLo: number, fHi: number, gain: number, push: (hz: number, m: number) => void): void {
  const bins = mag.length;
  const k0 = Math.max(2, Math.floor(fLo / binHz));
  const k1 = Math.min(bins - 3, Math.ceil(fHi / binHz));
  // A peak: a local maximum (±2 bins) standing above the local average (±12 bins).
  const r = 12;
  let local = 0;
  for (let k = k0 - r; k <= k0 + r; k++) local += mag[Math.max(0, k)]!;
  for (let k = k0; k <= k1; k++) {
    if (k > k0) local += mag[Math.min(bins - 1, k + r)]! - mag[Math.max(0, k - r - 1)]!;
    const m = mag[k]!;
    if (m <= mag[k - 1]! || m < mag[k + 1]! || m <= mag[k - 2]! || m < mag[k + 2]!) continue;
    if (m < (1.5 * local) / (2 * r + 1)) continue;
    const a = Math.log(mag[k - 1]! + 1e-12);
    const b = Math.log(m + 1e-12);
    const c = Math.log(mag[k + 1]! + 1e-12);
    const den = a - 2 * b + c;
    const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    const hz = (k + d) * binHz;
    if (hz >= fLo && hz < fHi) push(hz, m * gain);
  }
}

/** Where the bass analysis ends and the treble one starts (Hz). */
const SPLIT = 200;
/** Samples of one piece the stream takes at a time (a longer piece is cut). */
const PIECE = 1 << 16;
/** Peaks at 3, 5, 6 or 7 times a stronger lower peak count less: weights by code. */
const OVERTONE_WEIGHT = [1, 0.5, 0.25] as const;

/** Halving the rate (22.05 → 11.025 kHz): 2 kHz is all the pitch we need. */
const factorOf = (sampleRate: number) => (sampleRate > 16000 ? 2 : 1);

/** The signal's level at the chroma's own rate (the compression is scaled by it): fed in pieces like the stream. */
export class ChromaLevel {
  private readonly dec: Decimator | null;
  private readonly out: Float32Array;
  private sq = 0;
  private n = 0;

  constructor(sampleRate: number) {
    const factor = factorOf(sampleRate);
    this.dec = factor > 1 ? new Decimator(factor, sampleRate) : null;
    this.out = new Float32Array(Math.ceil(PIECE / factor) + 1);
  }

  push(mono: Float32Array): void {
    for (let o = 0; o < mono.length; o += PIECE) {
      const piece = mono.subarray(o, Math.min(mono.length, o + PIECE));
      let x: Float32Array = piece;
      let m = piece.length;
      if (this.dec) {
        m = this.dec.process(piece, this.out);
        x = this.out;
      }
      for (let i = 0; i < m; i++) this.sq += x[i]! * x[i]!;
      this.n += m;
    }
  }

  get sumSquares(): number {
    return this.sq;
  }

  get count(): number {
    return this.n;
  }

  get rms(): number {
    return Math.sqrt(this.sq / Math.max(1, this.n));
  }
}

export class ChromaStream {
  private readonly dec1: Decimator | null;
  private readonly dec4: Decimator;
  private readonly sr: number;
  private readonly size: number;
  private readonly hop: number;
  private readonly sizeB: number;
  private readonly hopB: number;
  private readonly fft: RealFFT;
  private readonly fftB: RealFFT;
  private readonly win: Float64Array;
  private readonly winB: Float64Array;
  private readonly mag: Float64Array;
  private readonly magB: Float64Array;
  private readonly norm: number;
  private readonly bufX: SlidingBuffer;
  private readonly bufB: SlidingBuffer;
  private readonly tmpX: Float32Array;
  private readonly tmpB: Float32Array;
  // The peaks of every frame so far: Hz and magnitude (float32 as before), the overtone code, and how many each frame has.
  private readonly pHz = new BlockedF32();
  private readonly pMag = new BlockedF32();
  private readonly pOvertone = new BlockedU8();
  private readonly perFrame: GrowF32;
  // The tuning's circular mean, summed as the peaks come.
  private re = 0;
  private im = 0;
  // Peaks of the frame being made.
  private readonly lh = new Float32Array(4096);
  private readonly lm = new Float32Array(4096);
  private lc = 0;
  /** The next frame to compute. */
  private f = 0;
  private done = false;

  /** `rms`: the level of the signal at half its rate (a `ChromaLevel`, or a sample of the song). */
  constructor(sampleRate: number, rms: number, expectedSamples = 0) {
    const factor = factorOf(sampleRate);
    this.dec1 = factor > 1 ? new Decimator(factor, sampleRate) : null;
    const sr = sampleRate / factor;
    this.sr = sr;
    this.size = nextPowerOfTwo(Math.round(0.37 * sr));
    this.hop = this.size / 4;
    // The bass (an 808 on F1 is 44 Hz) at a quarter of that rate with the same frames: four times the frequency resolution.
    this.dec4 = new Decimator(4, sr);
    this.sizeB = this.size / 2;
    this.hopB = this.hop / 4;
    this.fft = new RealFFT(this.size);
    this.fftB = new RealFFT(this.sizeB);
    this.win = hannWindow(this.size);
    this.winB = hannWindow(this.sizeB);
    this.mag = new Float64Array(this.fft.bins);
    this.magB = new Float64Array(this.fftB.bins);
    // Scale so the compression doesn't depend on the level (both passes alike).
    this.norm = rms > 1e-7 ? 0.1 / rms : 0;
    this.bufX = new SlidingBuffer(this.size + PIECE);
    this.bufB = new SlidingBuffer(this.sizeB + PIECE / 4 + 4);
    this.tmpX = new Float32Array(Math.ceil(PIECE / factor) + 1);
    this.tmpB = new Float32Array(Math.ceil((PIECE + 3) / 4) + 1);
    this.perFrame = new GrowF32(Math.ceil(expectedSamples / factor / this.hop) + 8);
  }

  get frameRate(): number {
    return this.sr / this.hop;
  }

  /** Peaks kept so far (9 bytes each). */
  get peaks(): number {
    return this.pHz.length;
  }

  /** Feeds the next samples of the signal (at the rate the stream was made for). */
  push(mono: Float32Array): void {
    if (this.done) throw new Error('The chroma stream is finished.');
    for (let o = 0; o < mono.length; o += PIECE) {
      const piece = mono.subarray(o, Math.min(mono.length, o + PIECE));
      let x: Float32Array = piece;
      let n = piece.length;
      if (this.dec1) {
        n = this.dec1.process(piece, this.tmpX);
        x = this.tmpX;
      }
      this.bufX.append(x, n);
      const nb = this.dec4.process(x, this.tmpB, n);
      this.bufB.append(this.tmpB, nb);
      this.run(false);
    }
  }

  private run(last: boolean): void {
    const { size, hop, sizeB, hopB, bufX, bufB } = this;
    const limit = last ? Math.ceil(bufX.end / hop) : Infinity;
    const viewX = bufX.view();
    const viewB = bufB.view();
    while (this.f < limit && (last || (this.f * hop + size / 2 <= bufX.end && this.f * hopB + sizeB / 2 <= bufB.end))) {
      this.frame(viewX, viewB);
      this.f++;
    }
    bufX.discardBefore(this.f * hop - size / 2);
    bufB.discardBefore(this.f * hopB - sizeB / 2);
  }

  private frame(viewX: Float32Array, viewB: Float32Array): void {
    const { f, norm } = this;
    this.lc = 0;
    const push = (hz: number, m: number) => {
      this.lh[this.lc] = hz;
      this.lm[this.lc] = m;
      this.lc++;
    };
    magnitudeSpectrum(this.fftB, viewB, f * this.hopB - this.sizeB / 2 - this.bufB.base, this.winB, this.magB);
    framePeaks(this.magB, this.sr / 4 / this.sizeB, 27, SPLIT, norm * (4 / this.sizeB), push);
    magnitudeSpectrum(this.fft, viewX, f * this.hop - this.size / 2 - this.bufX.base, this.win, this.mag);
    framePeaks(this.mag, this.sr / this.size, SPLIT, 2000, norm * (4 / this.size), push);
    // Harmonic emphasis: a peak at 3, 5, 6 or 7 times a stronger lower peak of the same frame is
    // mostly that note's overtone (a 5th, a major 3rd, a ♭7th away), so it counts little. Octaves
    // (2, 4, 8) are the same pitch class and stay. Peaks of a frame are in rising order.
    const { lh, lm, lc } = this;
    for (let j = 0; j < lc; j++) {
      const hz = lh[j]!;
      let code = 0;
      for (let i = 0; i < j; i++) {
        if (lm[i]! < 0.5 * lm[j]!) continue;
        const r = hz / lh[i]!;
        const h = Math.round(r);
        if ((h === 3 || h === 5 || h === 6 || h === 7) && Math.abs(r - h) < 0.03 * h) {
          code = h === 5 ? 1 : 2;
          break;
        }
      }
      this.pHz.push(hz);
      this.pMag.push(lm[j]!);
      this.pOvertone.push(code);
      // Tuning: the circular mean of the peaks' offsets from the nearest semitone.
      const s = 12 * Math.log2(hz / 440);
      const w = Math.sqrt(lm[j]!);
      const ang = 2 * Math.PI * (s - Math.round(s));
      this.re += w * Math.cos(ang);
      this.im += w * Math.sin(ang);
    }
    this.perFrame.push(lc);
  }

  /** The end of the signal: the remaining frames, then the chromagram. */
  finish(): Chromagram {
    if (!this.done) {
      this.run(true);
      this.done = true;
    }
    const frames = this.f;
    const { re, im } = this;
    const tuning = re === 0 && im === 0 ? 0 : (Math.atan2(im, re) / (2 * Math.PI)) * 100;
    const treble = new Float32Array(frames * 12);
    const bass = new Float32Array(frames * 12);
    const energy = new Float32Array(frames);
    let j = 0;
    for (let f = 0; f < frames; f++) {
      for (let c = this.perFrame.data[f]!; c > 0; c--, j++) {
        const hz = this.pHz.at(j);
        const s = 12 * Math.log2(hz / 440) - tuning / 100;
        const n = Math.round(s);
        const dev = s - n;
        const w = Math.sqrt(this.pMag.at(j)) * Math.cos(Math.PI * dev) ** 2 * OVERTONE_WEIGHT[this.pOvertone.at(j)]!;
        const pc = (((n + 9) % 12) + 12) % 12;
        if (hz < SPLIT) bass[f * 12 + pc] = bass[f * 12 + pc]! + w;
        else treble[f * 12 + pc] = treble[f * 12 + pc]! + w;
        energy[f] = energy[f]! + w;
      }
    }
    return { frameRate: this.frameRate, frames, treble, bass, energy, tuningCents: tuning };
  }
}

export function chromagram(mono: Float32Array, sampleRate: number, progress?: (fraction: number) => void): Chromagram {
  const level = new ChromaLevel(sampleRate);
  level.push(mono);
  const stream = new ChromaStream(sampleRate, level.rms, mono.length);
  const step = Math.max(1, Math.floor(mono.length / 10 / PIECE)) * PIECE;
  for (let o = 0; o < mono.length; o += step) {
    stream.push(mono.subarray(o, Math.min(mono.length, o + step)));
    progress?.(Math.min(1, (o + step) / mono.length));
  }
  return stream.finish();
}

/** Mean chroma (12 values, summing to 1, or all 0) over [t0, t1) seconds: treble plus `bassWeight` × bass. */
export function chromaBetween(c: Chromagram, t0: number, t1: number, bassWeight = 0.5): Float64Array {
  const out = new Float64Array(12);
  const a = Math.max(0, Math.round(t0 * c.frameRate));
  const b = Math.min(c.frames, Math.max(a + 1, Math.round(t1 * c.frameRate)));
  for (let f = a; f < b; f++)
    for (let k = 0; k < 12; k++) out[k] = out[k]! + c.treble[f * 12 + k]! + bassWeight * c.bass[f * 12 + k]!;
  let s = 0;
  for (let k = 0; k < 12; k++) s += out[k]!;
  if (s > 0) for (let k = 0; k < 12; k++) out[k] = out[k]! / s;
  return out;
}
