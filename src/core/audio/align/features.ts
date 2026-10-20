/**
 * What alignment listens to: a short feature vector for every 5 ms frame of a voice. Two voices singing the same words
 * differ in pitch, loudness and tone, so the vector describes the shape of the sound, not its level: the shape of the
 * spectrum (12 bands, relative to the frame's own loudness: tells vowels from consonants), the loudness against the
 * clip's own loud level, the spectral flux (how fast the spectrum is changing: syllable starts and consonants) and
 * whether the frame is voiced (the pitch tracker found a note). Frames outside the part of the sound that is audible
 * are silence, so the match never leans on audio the clip does not play.
 *
 * Pure and deterministic, no DOM; runs in a Worker or in Node.
 */
import { RealFFT, hannWindow, magnitudeSpectrum, nextPowerOfTwo } from '../../voice/fft';
import { trackVoicePitch } from '../../voice/pitch-notes';

/** Seconds between frames. */
export const ALIGN_HOP_SEC = 0.005;

/** The spectrum window is about 20 ms long (a power of two samples, so 1024 at 44.1 and 48 kHz). */
const WINDOW_SEC = 0.02;
/** Spectral shape bands, spaced evenly on the mel scale between these frequencies (Hz). */
const BAND_COUNT = 12;
const BAND_LOW_HZ = 100;
const BAND_HIGH_HZ = 7500;
/** Power floor: keeps the logarithm finite in digital silence. */
const POWER_FLOOR = 1e-12;
/** A frame is "sounding" from this far below the clip's loud level (dB) and fully so above `ACTIVE_FULL_DB` below it. */
const ACTIVE_NONE_DB = 55;
const ACTIVE_FULL_DB = 30;
/** The loud level is this percentile of the audible frames' loudness. */
const LOUD_PERCENTILE = 0.95;
/** Band levels more than this far under the frame's total (dB) count as that far under. */
const BAND_SHAPE_RANGE_DB = 40;
/** The loudness feature runs 0..1 over this many dB below the loud level. */
const LOUDNESS_RANGE_DB = 40;
/** Weights of the parts of the vector in the distance between two frames. */
const SHAPE_WEIGHT = 1;
const LOUDNESS_WEIGHT = 1.6;
const FLUX_WEIGHT = 1.6;
const VOICED_WEIGHT = 0.7;
/** Flux (dB per band, averaged) that counts as 1, and the most it can reach. */
const FLUX_UNIT_DB = 10;
const FLUX_MAX = 1.5;

/** Numbers in one frame's vector: the bands, loudness, flux and voiced. */
export const FEATURE_DIM = BAND_COUNT + 3;

/** The features of one voice over a stretch of time, a frame every `hopSec`. */
export interface FrameFeatures {
  frames: number;
  hopSec: number;
  /** Frame-major vectors, already weighted so the squared distance between two frames is the plain sum of squares. */
  vectors: Float32Array;
  /** 0..1: how much the frame is sounding (0 silence, 1 clearly in the sound). */
  activity: Float32Array;
  /** Fundamental in Hz per frame, 0 where unvoiced. */
  f0: Float32Array;
  /** 0..1.2: loudness against the clip's own loud level (0 = 40 dB under it or more). */
  loudness: Float32Array;
  /** Spectral flux per frame (1 = a 10 dB rise in every band), 0 in silence. */
  flux: Float32Array;
}

/** A voice to describe: its mono samples on the frame axis (index 0 = the time of frame 0) and the part that counts. */
export interface FeatureInput {
  mono: Float32Array;
  sampleRate: number;
  /** Number of frames to describe. */
  frames: number;
  /** Seconds (from frame 0) of the sound that is audible; the rest counts as silence. */
  audible: { fromSec: number; toSec: number };
}

/** Mel scale. */
const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1);

/** Triangular band weights over the FFT bins: `weights[b]` holds `[firstBin, ...weights]` for band b. */
function bandFilters(fftSize: number, sampleRate: number): { first: number; weights: Float32Array }[] {
  const high = Math.min(BAND_HIGH_HZ, 0.45 * sampleRate);
  const lowMel = hzToMel(BAND_LOW_HZ);
  const highMel = hzToMel(high);
  const edges: number[] = [];
  for (let e = 0; e <= BAND_COUNT + 1; e++) edges.push(melToHz(lowMel + ((highMel - lowMel) * e) / (BAND_COUNT + 1)));
  const binHz = sampleRate / fftSize;
  return Array.from({ length: BAND_COUNT }, (_, b) => {
    const [lo, mid, hi] = [edges[b] as number, edges[b + 1] as number, edges[b + 2] as number];
    const first = Math.max(1, Math.floor(lo / binHz));
    const last = Math.min(fftSize / 2, Math.ceil(hi / binHz));
    const weights = new Float32Array(Math.max(1, last - first + 1));
    for (let k = first; k <= last; k++) {
      const hz = k * binHz;
      weights[k - first] = hz <= mid ? Math.max(0, (hz - lo) / (mid - lo)) : Math.max(0, (hi - hz) / (hi - mid));
    }
    return { first, weights };
  });
}

/** The loudness and the band levels (dB) of every frame, before they are made relative. */
interface Spectra {
  bandDb: Float32Array;
  loudnessDb: Float32Array;
}

function measureSpectra(input: FeatureInput): Spectra {
  const { mono, sampleRate, frames } = input;
  const fftSize = nextPowerOfTwo(Math.round(WINDOW_SEC * sampleRate));
  const fft = new RealFFT(fftSize);
  const window = hannWindow(fftSize);
  let windowSum = 0;
  for (const w of window) windowSum += w;
  const norm = 1 / (windowSum * windowSum);
  const filters = bandFilters(fftSize, sampleRate);
  const power = new Float64Array(fft.bins);
  const bandDb = new Float32Array(frames * BAND_COUNT);
  const loudnessDb = new Float32Array(frames);
  const fromFrame = Math.floor(input.audible.fromSec / ALIGN_HOP_SEC);
  const toFrame = Math.ceil(input.audible.toSec / ALIGN_HOP_SEC);
  for (let k = 0; k < frames; k++) {
    const silent = k < fromFrame || k > toFrame;
    let total = 0;
    if (!silent) {
      const centre = Math.round(k * ALIGN_HOP_SEC * sampleRate);
      magnitudeSpectrum(fft, mono, centre - (fftSize >> 1), window, power, true);
    }
    for (let b = 0; b < BAND_COUNT; b++) {
      const { first, weights } = filters[b] as { first: number; weights: Float32Array };
      let sum = 0;
      if (!silent) for (let i = 0; i < weights.length; i++) sum += (weights[i] as number) * (power[first + i] as number);
      sum = sum * norm + POWER_FLOOR;
      total += sum;
      bandDb[k * BAND_COUNT + b] = 10 * Math.log10(sum);
    }
    loudnessDb[k] = 10 * Math.log10(total);
  }
  return { bandDb, loudnessDb };
}

/** The loudness (dB) that the clip's loud frames reach: a high percentile of the frames that are audible. */
function loudLevel(loudnessDb: Float32Array, audible: FeatureInput['audible'], frames: number): number {
  const from = Math.max(0, Math.floor(audible.fromSec / ALIGN_HOP_SEC));
  const to = Math.min(frames - 1, Math.ceil(audible.toSec / ALIGN_HOP_SEC));
  if (to < from) return 0;
  const values = Array.from(loudnessDb.subarray(from, to + 1)).sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * LOUD_PERCENTILE))] as number;
}

/** Pitch per frame (Hz, 0 unvoiced) from the shared tracker, read at the frame times. */
function pitchPerFrame(mono: Float32Array, sampleRate: number, frames: number): Float32Array {
  const f0 = new Float32Array(frames);
  if (mono.length < sampleRate * 0.05) return f0;
  const voice = trackVoicePitch(mono, sampleRate, { minHz: 65, maxHz: 1100 });
  for (let k = 0; k < frames; k++) {
    const at = Math.min(voice.f0.length - 1, Math.round((k * ALIGN_HOP_SEC) / voice.hop));
    f0[k] = at >= 0 ? (voice.f0[at] as number) : 0;
  }
  return f0;
}

/** Describes a voice: see the file header. */
export function frameFeatures(input: FeatureInput): FrameFeatures {
  const { frames } = input;
  const { bandDb, loudnessDb } = measureSpectra(input);
  const loud = loudLevel(loudnessDb, input.audible, frames);
  const f0 = pitchPerFrame(input.mono, input.sampleRate, frames);
  const fromFrame = Math.floor(input.audible.fromSec / ALIGN_HOP_SEC);
  const toFrame = Math.ceil(input.audible.toSec / ALIGN_HOP_SEC);
  for (let k = 0; k < frames; k++) if (k < fromFrame || k > toFrame) f0[k] = 0;
  const vectors = new Float32Array(frames * FEATURE_DIM);
  const activity = new Float32Array(frames);
  const loudness = new Float32Array(frames);
  const fluxPerFrame = new Float32Array(frames);
  for (let k = 0; k < frames; k++) {
    const level = (loudnessDb[k] as number) - loud;
    const active = Math.min(1, Math.max(0, (level + ACTIVE_NONE_DB) / (ACTIVE_NONE_DB - ACTIVE_FULL_DB)));
    activity[k] = active;
    const at = k * FEATURE_DIM;
    let flux = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const db = bandDb[k * BAND_COUNT + b] as number;
      const relative = Math.max(-BAND_SHAPE_RANGE_DB, db - (loudnessDb[k] as number)) / BAND_SHAPE_RANGE_DB;
      vectors[at + b] = relative * active * SHAPE_WEIGHT;
      if (k > 0) flux += Math.max(0, db - (bandDb[(k - 1) * BAND_COUNT + b] as number));
    }
    loudness[k] = Math.min(1.2, Math.max(0, 1 + level / LOUDNESS_RANGE_DB));
    fluxPerFrame[k] = Math.min(FLUX_MAX, flux / BAND_COUNT / FLUX_UNIT_DB) * active;
    vectors[at + BAND_COUNT] = (loudness[k] as number) * LOUDNESS_WEIGHT;
    vectors[at + BAND_COUNT + 1] = (fluxPerFrame[k] as number) * FLUX_WEIGHT;
    vectors[at + BAND_COUNT + 2] = (f0[k] as number) > 0 ? VOICED_WEIGHT : 0;
  }
  return { frames, hopSec: ALIGN_HOP_SEC, vectors, activity, f0, loudness, flux: fluxPerFrame };
}
