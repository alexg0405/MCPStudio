/**
 * The whole analysis of one audio file for the sample browser: one-shot or loop, a one-shot's category and note, a loop's
 * tempo, bars and key, plus loudness, brightness and a fingerprint for "similar sounds". Pure and synchronous on decoded
 * audio (the app runs it in a Worker, `app/samples`). Reuses the DJ analyzers (key from the chromagram), the transient
 * tempo detector and the voice pitch tracker; only the measurements and rules in this folder are new.
 */
import { detectTempo } from '../audio/transients';
import { chromagram, type Chromagram } from '../dj/chroma';
import { estimateKey } from '../dj/key';
import { onsetFeatures } from '../dj/onset';
import { trackBeats } from '../dj/tempo';
import { decimate } from '../voice/filters';
import { applyHint, classify } from './classify';
import { extractFeatures, monoMix, peakEnvelope, type SoundFeatures } from './features';
import { nameHint, type NameHint } from './names';
import { SAMPLE_ANALYSIS_VERSION, type LoopKind, type SampleAnalysis } from './types';
import { fingerprint } from './similarity';

/** Files longer than this are songs or recordings: not read in depth. */
export const LONG_SEC = 60;
/** Lengths in bars a loop is cut at. */
const LOOP_BARS = [0.5, 1, 2, 4, 8, 16, 32] as const;
/** The part of a loop that is analyzed. */
export const LOOP_ANALYSIS_SEC = 32;

export interface AnalyzeOptions {
  /** The file's path in its folder: its name and folders hint the category, tempo and key. */
  path?: string;
  /** The real length when `channels` hold only the start of the file. */
  durationSec?: number;
  /** The MIDI note the file says it is tuned to (a WAV `smpl` unity note): the producer's word beats a pitch measurement. */
  rootKey?: number;
}

/**
 * Times (s) where a new sound starts: a rise of 9 dB in the level of the signal (a peak envelope, so a low note's ripple
 * is not a hit) or in its high-passed copy (hats over a bass), measured against the loudest moment of the signal.
 */
export function findOnsets(x: Float32Array, sr: number): number[] {
  const block = Math.max(16, Math.round(sr * 0.005));
  const n = Math.floor(x.length / block);
  if (n < 12) return [];
  const toDb = (v: number) => 20 * Math.log10(v + 1e-9);
  const peak = peakEnvelope(x, block);
  const full = new Float32Array(n);
  let top = -200;
  for (let b = 0; b < n; b++) {
    full[b] = toDb(peak[b] as number);
    top = Math.max(top, full[b] as number);
  }
  // The high-passed copy (first difference) is 3 dB louder than the signal for white noise: compared on the same scale.
  const hp = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let sum = 0;
    const a = b * block;
    let prev = a > 0 ? (x[a - 1] as number) : 0;
    for (let i = a; i < a + block; i++) {
      const v = (x[i] as number) - prev;
      prev = x[i] as number;
      sum += v * v;
    }
    hp[b] = 10 * Math.log10(sum / block + 1e-12) - 3;
  }
  const times: number[] = [];
  for (const db of [full, hp]) {
    let last = -1e9;
    for (let b = 8; b < n; b++) {
      const v = db[b] as number;
      if (v < top - 40) continue;
      let low = 1e9;
      for (let k = b - 8; k < b; k++) low = Math.min(low, db[k] as number);
      if (v - low >= 9 && v >= (db[b + 1] ?? -200) - 3 && b - last >= 16) {
        // Walk forward to the local peak so a slow attack counts once.
        let p = b;
        while (p + 1 < n && (db[p + 1] as number) >= (db[p] as number)) p++;
        times.push((b * block) / sr);
        last = p;
      }
    }
  }
  times.sort((a, b) => a - b);
  // The two bands often find the same hit a block or two apart.
  const merged: number[] = [];
  for (const t of times) if (merged.length === 0 || t - (merged[merged.length - 1] as number) > 0.05) merged.push(t);
  return merged;
}

/**
 * The loop's tempo and bars, with the file name's tempo settling halves and doubles. Null when there is no steady
 * pulse, or the length is not a whole number of bars (then it is not a loop that repeats).
 */
export function loopTempo(
  mono: Float32Array,
  sr: number,
  durationSec: number,
  hint: NameHint = {},
): { bpm: number; bars: number; fitsBars: boolean } | null {
  // Whole bars (or half a bar): a loop is cut on the grid, so the length says which tempo reading is right.
  const fit = (t: number) => {
    const bars = (durationSec * t) / 240;
    const nearest = LOOP_BARS.reduce((best, n) => (Math.abs(n - bars) < Math.abs(best - bars) ? n : best), 1);
    return Math.abs(bars - nearest) <= 0.035 * Math.max(1, bars) ? nearest : null;
  };
  let bpm = detectTempo([mono], sr);
  if (hint.bpm !== undefined) {
    // The name is the producer's word: taken when it fits the length in whole bars, or is the measured tempo (or its half or double).
    const related = bpm !== null && [1, 2, 0.5].some((m) => Math.abs((bpm as number) * m - (hint.bpm as number)) / (hint.bpm as number) < 0.05);
    if (related || bpm === null || fit(hint.bpm) !== null) bpm = hint.bpm;
  } else if (bpm !== null && bpm <= 100) {
    // A half-time reading of a fast loop (drum and bass at 174 reads 87): the beat tracker knows where the drums sit.
    const decimation = Math.max(1, Math.floor(sr / 22050));
    const beats = trackBeats(onsetFeatures(decimate(mono, decimation, sr), sr / decimation));
    if (beats && beats.confidence >= 0.5 && Math.abs(beats.bpm - 2 * bpm) / (2 * bpm) < 0.03) bpm = beats.bpm;
  }
  if (bpm === null) return null;
  let bars = fit(bpm);
  let tempo = bpm;
  if (bars === null) {
    for (const m of [2, 0.5]) {
      const alt = bpm * m;
      const b = alt >= 60 && alt <= 200 ? fit(alt) : null;
      if (b !== null) {
        bars = b;
        tempo = alt;
        break;
      }
    }
  }
  return { bpm: Math.round(tempo * 10) / 10, bars: Math.max(1, Math.round(bars ?? (durationSec * tempo) / 240)), fitsBars: bars !== null };
}

/** What the loop is made of, from the energy it keeps low and whether it has a key. */
function loopKindOf(f: SoundFeatures, hasKey: boolean, hint: NameHint): LoopKind {
  // A name that says bass, drums or a melody settles it.
  if (hint.category === '808') return 'bass';
  if (hint.category && ['kick', 'snare', 'clap', 'hat', 'open-hat', 'cymbal', 'tom', 'perc'].includes(hint.category)) return 'drums';
  if (hint.category === 'tonal' || hint.category === 'vocal') return 'melodic';
  const low = (f.bands[0] as number) + (f.bands[1] as number);
  if (hasKey && low > 0.8 && f.centroid < 350) return 'bass';
  return hasKey ? 'melodic' : 'drums';
}

/** The pitch class that most of a signal's bass energy sits on (when it is at least half of it), else null. */
function dominantBassNote(c: Chromagram): number | null {
  const sum = new Float64Array(12);
  for (let f = 0; f < c.frames; f++) for (let k = 0; k < 12; k++) sum[k] = (sum[k] as number) + (c.bass[f * 12 + k] as number);
  const total = sum.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let best = 0;
  for (let k = 1; k < 12; k++) if ((sum[k] as number) > (sum[best] as number)) best = k;
  return (sum[best] as number) / total >= 0.5 ? best : null;
}

/** Analyzes decoded audio (`channels at `sampleRate`; only the first seconds are read). */
export function analyzeSample(channels: readonly Float32Array[], sampleRate: number, opts: AnalyzeOptions = {}): SampleAnalysis {
  const frames = channels[0]?.length ?? 0;
  const durationSec = opts.durationSec ?? frames / sampleRate;
  const hint = opts.path ? nameHint(opts.path) : {};
  const mono = monoMix(channels, sampleRate, LOOP_ANALYSIS_SEC);
  const f = extractFeatures(mono, sampleRate, durationSec);
  const base = { v: SAMPLE_ANALYSIS_VERSION, durationSec: Math.round(durationSec * 1000) / 1000 };
  const level = {
    loudnessDb: Math.round(f.loudnessDb * 10) / 10,
    peakDb: Math.round(f.peakDb * 10) / 10,
    brightness: Math.round(f.centroid),
  };

  if (durationSec > LONG_SEC) {
    return { ...base, kind: 'long', category: null, confidence: 0, ...level, vec: fingerprint(f, 'long') };
  }

  // One-shot or loop: several hits at a steady tempo over a whole number of bars (or the file says so).
  let isLoop = false;
  let tempo: ReturnType<typeof loopTempo> = null;
  if (durationSec >= 1 && hint.kind !== 'one-shot') {
    if (findOnsets(mono, sampleRate).length >= 5 || (hint.kind === 'loop' && durationSec >= 1.5)) {
      tempo = loopTempo(mono, sampleRate, durationSec, hint);
      isLoop = (tempo?.fitsBars ?? false) || (hint.kind === 'loop' && durationSec >= 1.5);
    }
  }

  if (isLoop) {
    const decimation = Math.max(1, Math.floor(sampleRate / 22050));
    const chroma = chromagram(decimate(mono, decimation, sampleRate), sampleRate / decimation);
    const key = estimateKey(chroma);
    const out: SampleAnalysis = {
      ...base,
      kind: 'loop',
      category: null,
      confidence: tempo?.fitsBars ? 0.85 : tempo ? 0.5 : 0.3,
      ...(tempo ? { bpm: tempo.bpm, bars: tempo.bars } : {}),
      loopKind: loopKindOf(f, key !== null && key.confidence >= 0.35, hint),
      ...level,
      vec: fingerprint(f, 'loop'),
    };
    if (key && key.confidence >= 0.35) {
      out.root = key.root;
      out.mode = key.mode;
      out.keyConfidence = key.confidence;
    } else if (hint.root !== undefined) {
      out.root = hint.root;
      if (hint.mode) out.mode = hint.mode;
      out.keyConfidence = 0.5;
    } else if (out.loopKind === 'bass' && hint.category === '808') {
      // A bass line named as one: a single repeated note has no key to find, but it has a note.
      const bass = dominantBassNote(chroma);
      if (bass !== null) {
        out.root = bass;
        out.keyConfidence = 0.4;
      }
    }
    return out;
  }

  const c = applyHint(classify(f), hint);
  const out: SampleAnalysis = { ...base, kind: 'one-shot', category: c.category, confidence: c.confidence, ...level, vec: fingerprint(f, 'one-shot'), basis: c.basis };
  // The note it sounds at: the file's own word when it carries one (not for noisy hits), else its steady pitch (kicks and 808s are tuned too).
  const NOTE_CATEGORIES = new Set(['tonal', '808', 'kick', 'tom', 'vocal', 'perc']);
  if (opts.rootKey !== undefined && Number.isInteger(opts.rootKey) && opts.rootKey >= 0 && opts.rootKey <= 127 && (!out.category || NOTE_CATEGORIES.has(out.category))) {
    out.midi = opts.rootKey;
    out.root = opts.rootKey % 12;
    out.keyConfidence = 0.95;
  } else if (f.f0 > 0 && f.voiced >= 0.6 && f.f0 >= 20 && f.f0 <= 4200) {
    const midi = 69 + 12 * Math.log2(f.f0 / 440);
    out.midi = Math.round(midi * 100) / 100;
    out.root = ((Math.round(midi) % 12) + 12) % 12;
    out.keyConfidence = Math.round(Math.min(1, f.voiced) * (1 - Math.min(1, f.pitchSpread / 2)) * 100) / 100;
  } else if (hint.root !== undefined && (c.category === 'tonal' || c.category === '808' || c.category === 'kick')) {
    out.root = hint.root;
    out.keyConfidence = 0.5;
  }
  return out;
}
