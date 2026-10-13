/**
 * Procedural stereo impulse response for the Reverb (pure, deterministic: same options → same IR).
 *
 * - Late tail: decorrelated L/R noise split into three bands, each with its own exponential decay
 *   e^(−6.91·t/RT60): lows ring 1.3× longer, highs die faster as `damping` rises.
 * - The diffuse tail builds up over the first half of the early-reflection window.
 * - 8–12 early reflections between 10 ms and 12–80 ms (`size`), different for each channel.
 * - 5 ms fade-in, then energy normalization (unit power gain), so `decay` doesn't change loudness.
 *   The ConvolverNode must use `disableNormalization: true`.
 */
import { Rng } from '@agstudio/sdk/dsp/random';

export interface ReverbIrOptions {
  sampleRate: number;
  /** RT60 of the mid band, seconds. */
  decay: number;
  /** 0–1: how much faster than the mids the highs decay. */
  damping: number;
  /** 0–1: spread of the early reflections (room size). */
  size: number;
  seed?: number;
}

/** Longest IR we generate, seconds. */
export const MAX_IR_SECONDS = 15;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const LOW_CROSSOVER = 500;
const HIGH_CROSSOVER = 4000;

/** Seconds of IR for these settings (until the longest band is 60 dB down). */
export function irSeconds(decay: number, size: number): number {
  return Math.min(MAX_IR_SECONDS, erWindow(size) + clamp(decay, 0.05, 20) * 1.3);
}

function erWindow(size: number): number {
  return 0.012 + 0.068 * clamp(size, 0, 1);
}

export function generateReverbIR(o: ReverbIrOptions): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const sr = o.sampleRate;
  const rt = clamp(o.decay, 0.05, 20);
  const damping = clamp(o.damping, 0, 1);
  const size = clamp(o.size, 0, 1);
  const erEnd = erWindow(size);
  const length = Math.max(1, Math.ceil(irSeconds(rt, size) * sr));
  const rtLow = rt * 1.3;
  const rtHigh = rt * (1 - 0.8 * damping);
  const aLow = 1 - Math.exp((-2 * Math.PI * LOW_CROSSOVER) / sr);
  const aHigh = 1 - Math.exp((-2 * Math.PI * HIGH_CROSSOVER) / sr);
  // Per-sample decay factors (e^(−6.91/(RT60·sr)) reaches −60 dB after RT60 seconds).
  const kLow = Math.exp(-6.91 / (rtLow * sr));
  const kMid = Math.exp(-6.91 / (rt * sr));
  const kHigh = Math.exp(-6.91 / (rtHigh * sr));
  const highLevel = 0.6 * (1 - 0.5 * damping);
  const buildUp = Math.max(1, Math.round(erEnd * 0.5 * sr));
  const fade = Math.max(1, Math.round(0.005 * sr));
  // Smaller rooms have relatively stronger early reflections.
  const erShare = 0.12 + 0.18 * (1 - size);
  const seed = (o.seed ?? 0x5eed) >>> 0;

  const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  for (let c = 0; c < 2; c++) {
    const out = channels[c] as Float32Array<ArrayBuffer>;
    const rng = new Rng((seed + c * 0x9e3779b9) >>> 0);
    let low = 0;
    let belowHigh = 0;
    let eLow = 1;
    let eMid = 1;
    let eHigh = 1;
    let tailEnergy = 0;
    for (let i = 0; i < length; i++) {
      const n = rng.bipolar();
      low += aLow * (n - low);
      belowHigh += aHigh * (n - belowHigh);
      let y = low * eLow + (belowHigh - low) * eMid + (n - belowHigh) * eHigh * highLevel;
      eLow *= kLow;
      eMid *= kMid;
      eHigh *= kHigh;
      if (i < buildUp) y *= i / buildUp;
      if (i < fade) y *= i / fade;
      out[i] = y;
      tailEnergy += y * y;
    }
    // Early reflections: decaying taps spread over the window, random signs.
    const taps = 8 + Math.round(4 * size);
    const er = new Float32Array(taps * 2);
    let erEnergy = 0;
    for (let k = 0; k < taps; k++) {
      const t = 0.01 + ((erEnd - 0.01) * (k + rng.next())) / taps;
      const amp = (1 - (0.6 * k) / taps) * (rng.next() < 0.5 ? -1 : 1);
      er[k * 2] = Math.min(length - 1, Math.round(t * sr));
      er[k * 2 + 1] = amp;
      erEnergy += amp * amp;
    }
    const tailScale = tailEnergy > 0 ? Math.sqrt((1 - erShare) / tailEnergy) : 0;
    const erScale = erEnergy > 0 ? Math.sqrt(erShare / erEnergy) : 0;
    for (let i = 0; i < length; i++) out[i] = (out[i] as number) * tailScale;
    for (let k = 0; k < taps; k++) {
      const i = er[k * 2] as number;
      out[i] = (out[i] as number) + (er[k * 2 + 1] as number) * erScale;
    }
    // Exact unit energy per channel.
    let energy = 0;
    for (let i = 0; i < length; i++) energy += (out[i] as number) ** 2;
    const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i++) out[i] = (out[i] as number) * norm;
  }
  return channels;
}
