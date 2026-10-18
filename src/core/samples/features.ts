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
  for (let b = 0; b < n; b++) out[b] = Math.max(raw[b] as number, b > 0 ? (raw[b - 1] as number) : 0, b > 1 ? (raw[b - 2] as number) : 0, b > 2 ? (raw[b - 3] as number) : 0);
  return out;
}

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1] as number;
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

/** Measures a mono signal (`x` may be longer than needed: only the start is read). */
export function extractFeatures(xFull: Float32Array, sampleRate: number, durationSec = xFull.length / sampleRate): SoundFeatures {
  const x = xFull.length > ENVELOPE_SEC * sampleRate ? xFull.subarray(0, Math.round(ENVELOPE_SEC * sampleRate)) : xFull;
  const sr = sampleRate;
  const f = silentFeatures(durationSec);
  if (x.length < 32) return f;

  // Level and envelope (5 ms blocks).
  const block = Math.max(8, Math.round(sr * 0.005));
  const blockSec = block / sr;
  const env = peakEnvelope(x, block);
  let pk = 0;
  for (let b = 1; b < env.length; b++) if ((env[b] as number) > (env[pk] as number)) pk = b;
  const peak = env[pk] as number;
  if (!(peak > 1e-6)) return f;
  f.peak = peak;
  f.peakDb = db(peak);
  let onset = 0;
  while (onset < pk && (env[onset] as number) < peak * 0.03) onset++;
  // Back to the foot of the attack (the level stops falling), so the onset isn't late on a slow rise.
  while (onset > 0 && (env[onset - 1] as number) < (env[onset] as number) && (env[onset - 1] as number) > peak * 0.003) onset--;
  f.onsetSec = onset * blockSec;
  f.attackSec = Math.max(0, (pk - onset) * blockSec);
  const last = (frac: number): number => {
    const thr = peak * frac;
    for (let b = env.length - 1; b > pk; b--) if ((env[b] as number) >= thr) return (b - pk) * blockSec;
    return 0;
  };
  f.t20 = last(0.1);
  f.t40 = last(0.01);
  f.t60 = last(0.001);
  f.len40 = f.attackSec + f.t40;
  let sustain = 0;
  for (let b = pk + Math.round(0.3 / blockSec); b <= pk + Math.round(0.5 / blockSec) && b < env.length; b++) sustain = Math.max(sustain, (env[b] as number) / peak);
  f.sustain = Math.min(1, sustain);
  const endBlocks = Math.max(1, Math.round(0.05 / blockSec));
  let end = 0;
  for (let b = Math.max(0, env.length - endBlocks); b < env.length; b++) end = Math.max(end, env[b] as number);
  f.endDb = db(end / peak);

  // Loudness over the audible blocks.
  {
    let sum = 0;
    let count = 0;
    const thr = peak * 0.01;
    for (let b = 0; b < env.length; b++) {
      if ((env[b] as number) < thr) continue;
      const a = b * block;
      const e = Math.min(x.length, a + block);
      for (let i = a; i < e; i++) sum += (x[i] as number) * (x[i] as number);
      count += e - a;
    }
    f.loudnessDb = count > 0 ? 10 * Math.log10(Math.max(1e-18, sum / count)) : -180;
  }

  const onsetSample = Math.max(0, Math.round(f.onsetSec * sr) - 64);

  // Spectrum over the body: the powers of overlapping frames added.
  {
    const fft = new RealFFT(FFT_SIZE);
    const win = hannWindow(FFT_SIZE);
    const bins = fft.bins;
    const binHz = sr / FFT_SIZE;
    const power = new Float64Array(bins);
    const frame = new Float64Array(bins);
    const frames = Math.max(2, Math.min(16, Math.ceil((BODY_SEC * sr) / FFT_HOP)));
    const attack = new Float64Array(bins);
    for (let k = 0; k < frames; k++) {
      const start = onsetSample + k * FFT_HOP;
      if (start >= x.length) break;
      magnitudeSpectrum(fft, x, start, win, frame, true);
      for (let i = 0; i < bins; i++) power[i] = (power[i] as number) + (frame[i] as number);
      if (k === 0) attack.set(frame);
    }
    const total = (a: Float64Array) => {
      let s = 0;
      for (let i = 1; i < bins; i++) s += a[i] as number;
      return s;
    };
    const edges = BAND_EDGES.map((hz) => Math.round(hz / binHz));
    const bandSum = [0, 0, 0, 0, 0, 0];
    let weighted = 0;
    let sum = 0;
    for (let i = 1; i < bins; i++) {
      const p = power[i] as number;
      let band = 0;
      while (band < edges.length && i >= (edges[band] as number)) band++;
      bandSum[band] = (bandSum[band] as number) + p;
      weighted += p * i * binHz;
      sum += p;
    }
    if (sum > 0) {
      f.bands = bandSum.map((s) => s / sum);
      f.centroid = weighted / sum;
      let acc = 0;
      for (let i = 1; i < bins; i++) {
        acc += power[i] as number;
        if (acc >= 0.85 * sum) {
          f.rolloff = i * binHz;
          break;
        }
      }
      // Flatness between 300 Hz and 16 kHz.
      const lo = Math.max(1, Math.round(300 / binHz));
      const hi = Math.min(bins - 1, Math.round(16000 / binHz));
      let logSum = 0;
      let lin = 0;
      const floor = (sum / bins) * 1e-6 + 1e-30;
      for (let i = lo; i <= hi; i++) {
        const p = (power[i] as number) + floor;
        logSum += Math.log(p);
        lin += p;
      }
      const n = Math.max(1, hi - lo + 1);
      f.flatness = Math.min(1, Math.exp(logSum / n) / (lin / n));
    }
    const at = total(attack);
    if (at > 0) {
      let w = 0;
      for (let i = 1; i < bins; i++) w += (attack[i] as number) * i * binHz;
      f.attackCentroid = w / at;
    }
  }

  // Bursts: separate attacks in the first 50 ms (1 ms RMS blocks).
  {
    const b1 = Math.max(4, Math.round(sr * 0.001));
    const count = Math.round(0.05 / (b1 / sr));
    const start = Math.max(0, Math.round(f.onsetSec * sr) - b1);
    const level: number[] = [];
    for (let k = 0; k < count; k++) {
      let s = 0;
      const a = start + k * b1;
      if (a + b1 > x.length) break;
      for (let i = a; i < a + b1; i++) s += (x[i] as number) * (x[i] as number);
      level.push(db(Math.sqrt(s / b1)));
    }
    // Smooth over 3 blocks, then count peaks that stand 4 dB over the valley before them after a 4 dB drop.
    const sm = level.map((_, i) => Math.max(level[i - 1] ?? -180, level[i] as number, level[i + 1] ?? -180));
    let bursts = sm.length > 0 ? 1 : 0;
    let top = sm[0] ?? 0;
    let bottom = top;
    let rising = true;
    for (let i = 1; i < sm.length; i++) {
      const v = sm[i] as number;
      if (rising) {
        top = Math.max(top, v);
        if (top - v >= 4) {
          rising = false;
          bottom = v;
        }
      } else {
        bottom = Math.min(bottom, v);
        if (v - bottom >= 4) {
          bursts++;
          rising = true;
          top = v;
        }
      }
    }
    f.bursts = bursts;
  }

  // Pitch of the body.
  {
    const segEnd = Math.min(x.length, onsetSample + Math.round(0.7 * sr));
    const seg = x.subarray(onsetSample, segEnd);
    if (seg.length > sr * 0.04) {
      const hop = Math.round(sr * 0.01);
      const t = trackPitch(seg, sr, { minHz: 28, maxHz: 1600, hop });
      const voiced: number[] = [];
      const voicedTime: number[] = [];
      let audible = 0;
      for (let i = 0; i < t.f0.length; i++) {
        if ((t.confidence[i] as number) > 0) audible++;
        if ((t.f0[i] as number) > 0 && (t.confidence[i] as number) >= 0.75) {
          voiced.push(12 * Math.log2((t.f0[i] as number) / 440) + 69);
          voicedTime.push(t.times[i] as number);
        }
      }
      f.voiced = audible > 0 ? voiced.length / audible : 0;
      if (voiced.length >= 3) {
        // The body: after the first 30 ms (kicks glide through them) when enough frames remain.
        let body = voiced.filter((_, i) => (voicedTime[i] as number) >= 0.03);
        if (body.length < 3) body = voiced;
        const m = median(body);
        f.f0 = 440 * Math.pow(2, (m - 69) / 12);
        const dev = body.map((v) => Math.abs(v - m));
        f.pitchSpread = median(dev);
        const first = voiced.slice(0, Math.min(3, voiced.length));
        f.pitchDrop = median(first) - m;
      }
    }
  }
  return f;
}
