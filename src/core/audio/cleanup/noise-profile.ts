/**
 * What the background noise of a recording looks like: the mean power of each frequency over a quiet stretch.
 * The offline noise reduction (`spectral-denoise.ts`) and the clip cleanup both learn it from the clip's own
 * sample, so the same range always gives the same profile and nothing big has to be stored in the project.
 */
import { hannWindow, RealFFT } from '../../voice/fft';

/** Seconds of a frame of the noise reduction's short-time transform: about 40 ms, a power of two in samples. */
const FRAME_SECONDS = 0.04;
/** Shortest stretch (seconds) the noise can be learned from: a few frames, or the estimate is too rough to trust. */
export const MIN_NOISE_SECONDS = 0.1;
/** The length of the stretch the automatic search looks for (seconds). */
export const AUTO_NOISE_SECONDS = 0.5;
/** Noise below this mean power (about −100 dBFS) is digital silence, not noise: nothing to learn. */
const SILENT_POWER = 1e-10;

/** The noise: power per frequency bin of the noise reduction's frames (`frameSize` samples at `sampleRate`). */
export interface NoiseProfile {
  frameSize: number;
  sampleRate: number;
  /** Mean of |X|² per bin (k = 0..frameSize/2) over the learned frames, with the transform's own window. */
  power: Float64Array;
}

/** A stretch of a sample in seconds. */
export interface Stretch {
  from: number;
  to: number;
}

/** The transform size for a sample rate: 2048 at 44.1 and 48 kHz (43 ms), 4096 at 96 kHz. */
export function denoiseFrameSize(sampleRate: number): number {
  let size = 256;
  while (size < sampleRate * FRAME_SECONDS) size *= 2;
  return size;
}

/** The window the noise reduction analyses and rebuilds with: the square root of a Hann window (sums to a constant at 75 % overlap). */
export function sqrtHannWindow(size: number): Float64Array {
  const w = hannWindow(size);
  for (let i = 0; i < size; i++) w[i] = Math.sqrt(w[i] as number);
  return w;
}

/** The mean of the channels (a copy of the only channel for mono): what the noise is measured and the voice is found in. */
export function monoOf(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const mix = new Float32Array(first.length);
  for (const channel of channels) for (let i = 0; i < mix.length; i++) mix[i] = (mix[i] as number) + (channel[i] as number);
  const scale = 1 / channels.length;
  for (let i = 0; i < mix.length; i++) mix[i] = (mix[i] as number) * scale;
  return mix;
}

/**
 * Learns the noise from `mono` between `from` and `to` seconds: the mean power per bin over every frame that fits
 * (hop = a quarter frame), lightly smoothed across neighbouring bins. Null when the stretch is shorter than a frame
 * or digital silence (there is no noise to learn).
 */
export function learnNoiseProfile(mono: Float32Array, sampleRate: number, from: number, to: number): NoiseProfile | null {
  const frameSize = denoiseFrameSize(sampleRate);
  const hop = frameSize / 4;
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(mono.length, Math.ceil(to * sampleRate));
  if (end - start < frameSize) return null;
  const fft = new RealFFT(frameSize);
  const window = sqrtHannWindow(frameSize);
  const bins = fft.bins;
  const sum = new Float64Array(bins);
  const re = new Float64Array(bins);
  const im = new Float64Array(bins);
  let frames = 0;
  for (let at = start; at + frameSize <= end; at += hop) {
    for (let i = 0; i < frameSize; i++) fft.frame[i] = (mono[at + i] as number) * (window[i] as number);
    fft.forward(fft.frame, re, im);
    for (let k = 0; k < bins; k++) sum[k] = (sum[k] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    frames++;
  }
  const power = smoothAcrossBins(sum, 1 / frames);
  let total = 0;
  for (let k = 0; k < bins; k++) total += power[k] as number;
  // Mean power per sample of the stretch: Σ|X|² = N·Σw²·σ² and Σw² = N/2 for this window.
  const perSample = total / bins / (frameSize / 2);
  return perSample < SILENT_POWER ? null : { frameSize, sampleRate, power };
}

/** `[1 2 1] / 4` across neighbouring bins (the edges repeat), scaled by `scale`: a few frames give a rough estimate per bin. */
function smoothAcrossBins(values: Float64Array, scale: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const left = values[Math.max(0, k - 1)] as number;
    const right = values[Math.min(n - 1, k + 1)] as number;
    out[k] = (0.25 * left + 0.5 * (values[k] as number) + 0.25 * right) * scale;
  }
  return out;
}

/** Seconds per step of the quiet-stretch search (the stretch starts on a multiple of it). */
const SEARCH_STEP_SECONDS = 0.01;

/**
 * The quietest stretch of `lengthSeconds` that is not digital silence: where the singer is not singing, breathing
 * or moving, so what remains is the room, the mic and the preamp. Null when the sound is shorter than the stretch
 * or silent throughout.
 */
export function findQuietStretch(mono: Float32Array, sampleRate: number, lengthSeconds = AUTO_NOISE_SECONDS): Stretch | null {
  const step = Math.max(1, Math.round(SEARCH_STEP_SECONDS * sampleRate));
  const blocks = Math.floor(mono.length / step);
  const wanted = Math.round(lengthSeconds / SEARCH_STEP_SECONDS);
  if (blocks < wanted || wanted < 1) return null;
  const power = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    for (let i = b * step; i < (b + 1) * step; i++) sum += (mono[i] as number) ** 2;
    power[b] = sum / step;
  }
  let running = 0;
  for (let b = 0; b < wanted; b++) running += power[b] as number;
  let best = -1;
  let bestMean = Infinity;
  for (let b = 0; b + wanted <= blocks; b++) {
    if (b > 0) running += (power[b + wanted - 1] as number) - (power[b - 1] as number);
    const mean = running / wanted;
    if (mean >= SILENT_POWER && mean < bestMean) {
      bestMean = mean;
      best = b;
    }
  }
  if (best < 0) return null;
  return { from: (best * step) / sampleRate, to: ((best + wanted) * step) / sampleRate };
}
