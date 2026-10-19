/**
 * Measurements of one sound for the sample browser: level, envelope (attack, decay times), spectrum
 * (energy bands, centroid, flatness), pitch (YIN, from `core/voice`) and the transients inside it. Pure
 * TypeScript on a mono signal, so it runs in a Worker and in Node tests. Only the first few seconds are read.
 */
import { RealFFT, hannWindow, magnitudeSpectrum } from '../voice/fft';
import { trackPitch } from '../voice/pitch';

/** Frequencies (Hz) that split the energy bands: sub, low, low-mid, mid, high, air. */
export const BAND_EDGES = [90, 250, 1000, 4000, 10000] as const;
const FFT_SIZE = 2048;
const FFT_HOP = 1024;
/** Longest stretch of a sound the spectrum and pitch are measured over (s after the onset). */
const BODY_SEC = 0.45;
/** Longest stretch the envelope is measured over (s). */
export const ENVELOPE_SEC = 4;

/** Anything shorter than this (frames) is too short to measure. */
const MIN_FRAMES = 32;
/** A peak under this is silence. */
const SILENT_PEAK = 1e-6;
/** The envelope's blocks are 5 ms (at least 8 frames). */
const ENVELOPE_BLOCK_SEC = 0.005;
const MIN_ENVELOPE_BLOCK = 8;
/** The sound begins where the envelope first reaches 3 % of its peak (−30 dB)… */
const ONSET_LEVEL = 0.03;
/** …and the onset is walked back to the foot of the attack, down to 0.3 % (−50 dB). */
const ATTACK_FOOT_LEVEL = 0.003;
/** The decay times are where the level last exceeds −20, −40 and −60 dB under the peak. */
const T20_LEVEL = 0.1;
const T40_LEVEL = 0.01;
const T60_LEVEL = 0.001;
/** Sustain is the loudest level 0.3 to 0.5 s after the peak. */
const SUSTAIN_FROM_SEC = 0.3;
const SUSTAIN_TO_SEC = 0.5;
/** The end level is the loudest block in the last 50 ms. */
const END_SEC = 0.05;
/** Loudness counts the blocks within 40 dB of the peak. */
const LOUDNESS_GATE = 0.01;
/** The spectrum starts this many frames before the onset block (the attack's own foot). */
const SPECTRUM_LEAD_FRAMES = 64;
/** Most frames of the body's spectrum that are added (the first is also kept alone for the attack centroid). */
const MAX_SPECTRUM_FRAMES = 16;
/** Flatness is measured between these frequencies (Hz). */
const FLATNESS_LOW_HZ = 300;
const FLATNESS_HIGH_HZ = 16000;
/** The rolloff is the frequency under which this share of the energy lies. */
const ROLLOFF_SHARE = 0.85;
/** Bursts are counted over the first 50 ms in 1 ms blocks. */
const BURST_WINDOW_SEC = 0.05;
const BURST_BLOCK_SEC = 0.001;
const MIN_BURST_BLOCK = 4;
/** A burst is a peak 4 dB over the valley before it, after a 4 dB drop. */
const BURST_STEP_DB = 4;
/** The pitch is tracked over this much of the sound after its onset (s), and needs more than 40 ms. */
const PITCH_SPAN_SEC = 0.7;
const MIN_PITCH_SPAN_SEC = 0.04;
/** The pitch tracker's range (Hz) and frame hop (s) for sounds. */
const PITCH_MIN_HZ = 28;
const PITCH_MAX_HZ = 1600;
const PITCH_HOP_SEC = 0.01;
/** A frame is voiced at this YIN confidence. */
const VOICED_CONFIDENCE = 0.75;
/** The body of a pitched sound starts after the first 30 ms (kicks glide through them). */
const BODY_START_SEC = 0.03;
/** At least this many voiced frames are needed for a pitch. */
const MIN_VOICED_FRAMES = 3;

export interface SoundFeatures {
  durationSec: number;
  /** Linear peak. */
  peak: number;
  peakDb: number;
  /** RMS over the blocks within 40 dB of the peak, dBFS. */
  loudnessDb: number;
  /** Seconds from the start of the file to where the sound begins (−30 dB under its peak). */
  onsetSec: number;
  /** From the onset to the loudest moment. */
  attackSec: number;
  /** Seconds from the peak until the level last exceeds −20 / −40 / −60 dB under it. */
  t20: number;
  t40: number;
  t60: number;
  /** Seconds from the onset until the level last exceeds −40 dB under the peak (the audible length; t40 starts at the peak). */
  len40: number;
  /** Energy shares of the six bands (sum 1). */
  bands: number[];
  /** Hz, power weighted, over the first 0.45 s of the sound / over its first 46 ms. */
  centroid: number;
  attackCentroid: number;
  /** Hz under which 85 % of the energy lies. */
  rolloff: number;
  /** 0 (a pure tone) … 1 (white noise), over 300 Hz–16 kHz. */
  flatness: number;
  /** Level 0.3–0.5 s after the peak relative to the peak (0..1): 808s ring on, drums are gone. */
  sustain: number;
  /** Separate attacks inside the first 50 ms (a clap's 3–4 bursts; a single hit has 1). */
  bursts: number;
  /** Median pitch of the body in Hz (0: none found), the share of audible frames that are pitched, the glide down from the first frames to the body in semitones, and the spread of the body's pitch in semitones. */
  f0: number;
  voiced: number;
  pitchDrop: number;
  pitchSpread: number;
  /** Level of the last 50 ms of the analyzed part in dB under the peak (a sound cut off while loud ends near 0). */
  endDb: number;
}

const db = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

/** Mono mix of the first `seconds` of a signal (the channels averaged). */
export function monoMix(channels: readonly Float32Array[], sampleRate: number, seconds = Infinity): Float32Array {
  const len = Math.min(channels[0]?.length ?? 0, Math.round(seconds * sampleRate));
  const out = new Float32Array(len);
  const n = channels.length;
  if (n === 0) return out;
  if (n === 1) {
    out.set((channels[0] as Float32Array).subarray(0, len));
    return out;
  }
  for (const c of channels) for (let i = 0; i < len; i++) out[i] = (out[i] as number) + (c[i] as number);
  for (let i = 0; i < len; i++) out[i] = (out[i] as number) / n;
  return out;
}

/** Per-block absolute peak, with a short running maximum so a low note's ripple doesn't read as decay. */
export function peakEnvelope(x: Float32Array, block: number): Float32Array {
  const n = Math.ceil(x.length / block);
  const raw = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let m = 0;
    const end = Math.min(x.length, (b + 1) * block);
    for (let i = b * block; i < end; i++) {
      const v = Math.abs(x[i] as number);
      if (v > m) m = v;
    }
    raw[b] = m;
  }
  const out = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    const here = raw[b] as number;
    const one = b > 0 ? (raw[b - 1] as number) : 0;
    const two = b > 1 ? (raw[b - 2] as number) : 0;
    const three = b > 2 ? (raw[b - 3] as number) : 0;
    out[b] = Math.max(here, one, two, three);
  }
  return out;
}

/** The middle value of a list (the upper one of the two middle values for an even count); 0 for an empty list. */
const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[sorted.length >> 1] as number;
};

/** The silence an empty file has: every measurement at its neutral value. */
export function silentFeatures(durationSec: number): SoundFeatures {
  return {
    durationSec,
    peak: 0,
    peakDb: -180,
    loudnessDb: -180,
    onsetSec: 0,
    attackSec: 0,
    t20: 0,
    t40: 0,
    t60: 0,
    len40: 0,
    bands: [0, 0, 0, 0, 0, 0],
    centroid: 0,
    attackCentroid: 0,
    rolloff: 0,
    flatness: 1,
    sustain: 0,
    bursts: 0,
    f0: 0,
    voiced: 0,
    pitchDrop: 0,
    pitchSpread: 0,
    endDb: -180,
  };
}

/** A copy without any DC offset (some files have one: it would read as a long tail on a short hit): a one-pole high-pass at 15 Hz. */
function withoutDc(x: Float32Array, sr: number): Float32Array {
  const out = new Float32Array(x.length);
  const r = 1 - (2 * Math.PI * 15) / sr;
  let prev = 0;
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    y = v - prev + r * y;
    prev = v;
    out[i] = y;
  }
  return out;
}

/** The envelope measurements the other steps build on. */
interface EnvelopeInfo {
  env: Float32Array;
  /** Frames per envelope block. */
  block: number;
  blockSec: number;
  /** Index of the loudest block. */
  peakBlock: number;
  peak: number;
}

/**
 * Measures a mono signal (`x` may be longer than needed: only the start is read). Each step fills in
 * its own part of the result; a silent signal gets the neutral values `silentFeatures` has.
 */
export function extractFeatures(
  xFull: Float32Array,
  sampleRate: number,
  durationSec = xFull.length / sampleRate,
): SoundFeatures {
  const sr = sampleRate;
  const span = xFull.length > ENVELOPE_SEC * sr ? xFull.subarray(0, Math.round(ENVELOPE_SEC * sr)) : xFull;
  const x = withoutDc(span, sr);
  const f = silentFeatures(durationSec);
  if (x.length < MIN_FRAMES) return f;

  const envelope = measureEnvelope(x, sr, f);
  if (!envelope) return f;
  measureLoudness(x, envelope, f);
  const onsetSample = Math.max(0, Math.round(f.onsetSec * sr) - SPECTRUM_LEAD_FRAMES);
  measureSpectrum(x, sr, onsetSample, f);
  f.bursts = countBursts(x, sr, f.onsetSec);
  measurePitch(x, sr, onsetSample, f);
  return f;
}

/** The level over time: peak, onset, attack, decay times, sustain and end level (5 ms blocks). Null for silence. */
function measureEnvelope(x: Float32Array, sr: number, f: SoundFeatures): EnvelopeInfo | null {
  const block = Math.max(MIN_ENVELOPE_BLOCK, Math.round(sr * ENVELOPE_BLOCK_SEC));
  const blockSec = block / sr;
  const env = peakEnvelope(x, block);
  let peakBlock = 0;
  for (let b = 1; b < env.length; b++) if ((env[b] as number) > (env[peakBlock] as number)) peakBlock = b;
  const peak = env[peakBlock] as number;
  if (!(peak > SILENT_PEAK)) return null;
  f.peak = peak;
  f.peakDb = db(peak);
  const onset = onsetBlock(env, peakBlock, peak);
  f.onsetSec = onset * blockSec;
  f.attackSec = Math.max(0, (peakBlock - onset) * blockSec);
  const decayTime = (share: number): number => {
    const threshold = peak * share;
    for (let b = env.length - 1; b > peakBlock; b--) {
      if ((env[b] as number) >= threshold) return (b - peakBlock) * blockSec;
    }
    return 0;
  };
  f.t20 = decayTime(T20_LEVEL);
  f.t40 = decayTime(T40_LEVEL);
  f.t60 = decayTime(T60_LEVEL);
  f.len40 = f.attackSec + f.t40;
  f.sustain = sustainShare(env, peakBlock, peak, blockSec);
  f.endDb = db(endLevel(env, blockSec) / peak);
  return { env, block, blockSec, peakBlock, peak };
}

/** The block where the sound begins: first over 3 % of the peak, then back to the foot of its attack. */
function onsetBlock(env: Float32Array, peakBlock: number, peak: number): number {
  let onset = 0;
  while (onset < peakBlock && (env[onset] as number) < peak * ONSET_LEVEL) onset++;
  // Back to the foot of the attack (the level stops falling), so the onset isn't late on a slow rise.
  while (
    onset > 0 &&
    (env[onset - 1] as number) < (env[onset] as number) &&
    (env[onset - 1] as number) > peak * ATTACK_FOOT_LEVEL
  ) {
    onset--;
  }
  return onset;
}

/** The loudest level 0.3–0.5 s after the peak, relative to the peak (0..1). */
function sustainShare(env: Float32Array, peakBlock: number, peak: number, blockSec: number): number {
  let sustain = 0;
  const from = peakBlock + Math.round(SUSTAIN_FROM_SEC / blockSec);
  const to = peakBlock + Math.round(SUSTAIN_TO_SEC / blockSec);
  for (let b = from; b <= to && b < env.length; b++) sustain = Math.max(sustain, (env[b] as number) / peak);
  return Math.min(1, sustain);
}

/** The loudest level in the last 50 ms of the envelope. */
function endLevel(env: Float32Array, blockSec: number): number {
  const endBlocks = Math.max(1, Math.round(END_SEC / blockSec));
  let end = 0;
  for (let b = Math.max(0, env.length - endBlocks); b < env.length; b++) end = Math.max(end, env[b] as number);
  return end;
}

/** RMS over the audible blocks (within 40 dB of the peak), dBFS. */
function measureLoudness(x: Float32Array, e: EnvelopeInfo, f: SoundFeatures): void {
  let sum = 0;
  let count = 0;
  const threshold = e.peak * LOUDNESS_GATE;
  for (let b = 0; b < e.env.length; b++) {
    if ((e.env[b] as number) < threshold) continue;
    const from = b * e.block;
    const to = Math.min(x.length, from + e.block);
    for (let i = from; i < to; i++) sum += (x[i] as number) * (x[i] as number);
    count += to - from;
  }
  f.loudnessDb = count > 0 ? 10 * Math.log10(Math.max(1e-18, sum / count)) : -180;
}

/** The energy of overlapping frames over the body of the sound, added, and the first frame alone (the attack). */
function bodySpectrum(x: Float32Array, sr: number, onsetSample: number): { power: Float64Array; attack: Float64Array } {
  const fft = new RealFFT(FFT_SIZE);
  const win = hannWindow(FFT_SIZE);
  const bins = fft.bins;
  const power = new Float64Array(bins);
  const frame = new Float64Array(bins);
  const attack = new Float64Array(bins);
  const frames = Math.max(2, Math.min(MAX_SPECTRUM_FRAMES, Math.ceil((BODY_SEC * sr) / FFT_HOP)));
  for (let k = 0; k < frames; k++) {
    const start = onsetSample + k * FFT_HOP;
    if (start >= x.length) break;
    magnitudeSpectrum(fft, x, start, win, frame, true);
    for (let i = 0; i < bins; i++) power[i] = (power[i] as number) + (frame[i] as number);
    if (k === 0) attack.set(frame);
  }
  return { power, attack };
}

/** Energy shares of the six bands, the power-weighted centroid and the total energy; null when there is none. */
function bandShares(power: Float64Array, binHz: number): { bands: number[]; centroid: number; total: number } | null {
  const edges = BAND_EDGES.map((hz) => Math.round(hz / binHz));
  const bandSum = [0, 0, 0, 0, 0, 0];
  let weighted = 0;
  let sum = 0;
  for (let i = 1; i < power.length; i++) {
    const p = power[i] as number;
    let band = 0;
    while (band < edges.length && i >= (edges[band] as number)) band++;
    bandSum[band] = (bandSum[band] as number) + p;
    weighted += p * i * binHz;
    sum += p;
  }
  if (!(sum > 0)) return null;
  return { bands: bandSum.map((s) => s / sum), centroid: weighted / sum, total: sum };
}

/** The frequency under which 85 % of the energy lies. */
function rolloffHz(power: Float64Array, binHz: number, total: number): number {
  let acc = 0;
  for (let i = 1; i < power.length; i++) {
    acc += power[i] as number;
    if (acc >= ROLLOFF_SHARE * total) return i * binHz;
  }
  return 0;
}

/** Spectral flatness between 300 Hz and 16 kHz: geometric over arithmetic mean of the power (1 = white noise). */
function flatnessOf(power: Float64Array, binHz: number, total: number): number {
  const bins = power.length;
  const lo = Math.max(1, Math.round(FLATNESS_LOW_HZ / binHz));
  const hi = Math.min(bins - 1, Math.round(FLATNESS_HIGH_HZ / binHz));
  let logSum = 0;
  let linear = 0;
  const floor = (total / bins) * 1e-6 + 1e-30;
  for (let i = lo; i <= hi; i++) {
    const p = (power[i] as number) + floor;
    logSum += Math.log(p);
    linear += p;
  }
  const n = Math.max(1, hi - lo + 1);
  return Math.min(1, Math.exp(logSum / n) / (linear / n));
}

/** Spectrum over the body (bands, centroid, rolloff, flatness) and the centroid of the attack alone. */
function measureSpectrum(x: Float32Array, sr: number, onsetSample: number, f: SoundFeatures): void {
  const binHz = sr / FFT_SIZE;
  const { power, attack } = bodySpectrum(x, sr, onsetSample);
  const shares = bandShares(power, binHz);
  if (shares) {
    f.bands = shares.bands;
    f.centroid = shares.centroid;
    f.rolloff = rolloffHz(power, binHz, shares.total);
    f.flatness = flatnessOf(power, binHz, shares.total);
  }
  let attackTotal = 0;
  for (let i = 1; i < attack.length; i++) attackTotal += attack[i] as number;
  if (attackTotal > 0) {
    let weighted = 0;
    for (let i = 1; i < attack.length; i++) weighted += (attack[i] as number) * i * binHz;
    f.attackCentroid = weighted / attackTotal;
  }
}

/** The level in dB of consecutive 1 ms blocks from just before the onset, as long as the signal lasts. */
function burstLevels(x: Float32Array, sr: number, onsetSec: number): number[] {
  const block = Math.max(MIN_BURST_BLOCK, Math.round(sr * BURST_BLOCK_SEC));
  const count = Math.round(BURST_WINDOW_SEC / (block / sr));
  const start = Math.max(0, Math.round(onsetSec * sr) - block);
  const levels: number[] = [];
  for (let k = 0; k < count; k++) {
    let sum = 0;
    const from = start + k * block;
    if (from + block > x.length) break;
    for (let i = from; i < from + block; i++) sum += (x[i] as number) * (x[i] as number);
    levels.push(db(Math.sqrt(sum / block)));
  }
  return levels;
}

/** Separate attacks in the first 50 ms (1 ms RMS blocks): a clap has 3–4, a single hit 1. */
function countBursts(x: Float32Array, sr: number, onsetSec: number): number {
  const level = burstLevels(x, sr, onsetSec);
  // Smooth over 3 blocks, then count peaks that stand 4 dB over the valley before them after a 4 dB drop.
  const smooth = level.map((_, i) => Math.max(level[i - 1] ?? -180, level[i] as number, level[i + 1] ?? -180));
  let bursts = smooth.length > 0 ? 1 : 0;
  let top = smooth[0] ?? 0;
  let bottom = top;
  let isRising = true;
  for (let i = 1; i < smooth.length; i++) {
    const v = smooth[i] as number;
    if (isRising) {
      top = Math.max(top, v);
      if (top - v >= BURST_STEP_DB) {
        isRising = false;
        bottom = v;
      }
    } else {
      bottom = Math.min(bottom, v);
      if (v - bottom >= BURST_STEP_DB) {
        bursts++;
        isRising = true;
        top = v;
      }
    }
  }
  return bursts;
}

/** Pitch of the body (YIN): median pitch, share of audible frames that are pitched, the glide down and the spread. */
function measurePitch(x: Float32Array, sr: number, onsetSample: number, f: SoundFeatures): void {
  const segmentEnd = Math.min(x.length, onsetSample + Math.round(PITCH_SPAN_SEC * sr));
  const segment = x.subarray(onsetSample, segmentEnd);
  if (segment.length <= sr * MIN_PITCH_SPAN_SEC) return;
  const hop = Math.round(sr * PITCH_HOP_SEC);
  const track = trackPitch(segment, sr, { minHz: PITCH_MIN_HZ, maxHz: PITCH_MAX_HZ, hop });
  const voiced: number[] = [];
  const voicedTime: number[] = [];
  let audible = 0;
  for (let i = 0; i < track.f0.length; i++) {
    if ((track.confidence[i] as number) > 0) audible++;
    if ((track.f0[i] as number) > 0 && (track.confidence[i] as number) >= VOICED_CONFIDENCE) {
      voiced.push(12 * Math.log2((track.f0[i] as number) / 440) + 69);
      voicedTime.push(track.times[i] as number);
    }
  }
  f.voiced = audible > 0 ? voiced.length / audible : 0;
  if (voiced.length < MIN_VOICED_FRAMES) return;
  // The body: after the first 30 ms (kicks glide through them) when enough frames remain.
  let body = voiced.filter((_, i) => (voicedTime[i] as number) >= BODY_START_SEC);
  if (body.length < MIN_VOICED_FRAMES) body = voiced;
  const middle = median(body);
  f.f0 = 440 * Math.pow(2, (middle - 69) / 12);
  f.pitchSpread = median(body.map((v) => Math.abs(v - middle)));
  const firstFrames = voiced.slice(0, Math.min(3, voiced.length));
  f.pitchDrop = median(firstFrames) - middle;
}
