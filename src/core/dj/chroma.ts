/**
 * Chromagram for key detection and harmonic change: spectral peaks from 27 Hz to 2 kHz (the bass at
 * ~2.8 kHz with 740 ms frames, the rest at ~11 kHz with 370 ms frames, both on 93 ms hops) mapped to
 * pitch classes after estimating the song's tuning (how far its notes sit from A = 440 Hz), weighted
 * by compressed magnitude, overtones of lower notes counting little. Bass (below 200 Hz) and treble
 * are kept apart: the bass says most about the tonic. Pure TypeScript, no DOM.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../voice/fft';
import { decimate } from '../voice/filters';

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

class Growable {
  data = new Float32Array(1024);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
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

export function chromagram(mono: Float32Array, sampleRate: number, progress?: (fraction: number) => void): Chromagram {
  // Halve the rate (22.05 → 11.025 kHz): 2 kHz is all the pitch we need.
  const factor = sampleRate > 16000 ? 2 : 1;
  const x = factor > 1 ? decimate(mono, factor, sampleRate) : mono;
  const sr = sampleRate / factor;
  const size = nextPowerOfTwo(Math.round(0.37 * sr));
  const hop = size / 4;
  // The bass (an 808 on F1 is 44 Hz) at a quarter of that rate with the same frames: four times
  // the frequency resolution.
  const xb = decimate(x, 4, sr);
  const srb = sr / 4;
  const sizeB = size / 2;
  const hopB = hop / 4;
  const fft = new RealFFT(size);
  const fftB = new RealFFT(sizeB);
  const win = hannWindow(size);
  const winB = hannWindow(sizeB);
  const mag = new Float64Array(fft.bins);
  const magB = new Float64Array(fftB.bins);
  const frames = Math.max(0, Math.ceil(x.length / hop));
  // Scale so the compression doesn't depend on the level (both passes alike).
  let sq = 0;
  for (let i = 0; i < x.length; i++) sq += x[i]! * x[i]!;
  const rms = Math.sqrt(sq / Math.max(1, x.length));
  const norm = rms > 1e-7 ? 0.1 / rms : 0;
  const pf = new Growable();
  const pm = new Growable();
  const pi = new Growable();
  const step = Math.max(1, Math.floor(frames / 10));
  for (let f = 0; f < frames; f++) {
    const push = (hz: number, m: number) => {
      pf.push(hz);
      pm.push(m);
      pi.push(f);
    };
    magnitudeSpectrum(fftB, xb, f * hopB - sizeB / 2, winB, magB);
    framePeaks(magB, srb / sizeB, 27, SPLIT, norm * (4 / sizeB), push);
    magnitudeSpectrum(fft, x, f * hop - size / 2, win, mag);
    framePeaks(mag, sr / size, SPLIT, 2000, norm * (4 / size), push);
    if (progress && f % step === 0) progress(f / frames);
  }
  // Tuning: the circular mean of the peaks' offsets from the nearest semitone.
  let re = 0;
  let im = 0;
  for (let j = 0; j < pf.length; j++) {
    const s = 12 * Math.log2(pf.data[j]! / 440);
    const w = Math.sqrt(pm.data[j]!);
    const ang = 2 * Math.PI * (s - Math.round(s));
    re += w * Math.cos(ang);
    im += w * Math.sin(ang);
  }
  const tuning = re === 0 && im === 0 ? 0 : (Math.atan2(im, re) / (2 * Math.PI)) * 100;
  const treble = new Float32Array(frames * 12);
  const bass = new Float32Array(frames * 12);
  const energy = new Float32Array(frames);
  // Harmonic emphasis: a peak at 3, 5, 6 or 7 times a stronger lower peak of the same frame is
  // mostly that note's overtone (a 5th, a major 3rd, a ♭7th away), so it counts little. Octaves
  // (2, 4, 8) are the same pitch class and stay. Peaks of a frame are stored in rising order.
  const overtone = new Float32Array(pf.length).fill(1);
  for (let j = 0, start = 0; j < pf.length; j++) {
    if (j > 0 && pi.data[j] !== pi.data[j - 1]) start = j;
    const hz = pf.data[j]!;
    for (let i = start; i < j; i++) {
      if (pm.data[i]! < 0.5 * pm.data[j]!) continue;
      const r = hz / pf.data[i]!;
      const h = Math.round(r);
      if ((h === 3 || h === 5 || h === 6 || h === 7) && Math.abs(r - h) < 0.03 * h) {
        overtone[j] = h === 5 ? 0.5 : 0.25;
        break;
      }
    }
  }
  for (let j = 0; j < pf.length; j++) {
    const hz = pf.data[j]!;
    const s = 12 * Math.log2(hz / 440) - tuning / 100;
    const n = Math.round(s);
    const dev = s - n;
    const w = Math.sqrt(pm.data[j]!) * Math.cos(Math.PI * dev) ** 2 * overtone[j]!;
    const pc = (((n + 9) % 12) + 12) % 12;
    const f = pi.data[j]!;
    if (hz < SPLIT) bass[f * 12 + pc] = bass[f * 12 + pc]! + w;
    else treble[f * 12 + pc] = treble[f * 12 + pc]! + w;
    energy[f] = energy[f]! + w;
  }
  return { frameRate: sr / hop, frames, treble, bass, energy, tuningCents: tuning };
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
