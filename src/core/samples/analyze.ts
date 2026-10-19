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

/** A file shorter than this is a one-shot, never a loop (s). */
const MIN_LOOP_SEC = 1;
/** A file the name calls a loop counts as one from this length (s). */
const MIN_NAMED_LOOP_SEC = 1.5;
/** A loop has at least this many separate hits. */
const MIN_LOOP_ONSETS = 5;
/** A key is trusted from this confidence. */
const MIN_KEY_CONFIDENCE = 0.35;
/** The rate the key and the beat tracker work at (Hz); longer signals are decimated toward it. */
const TARGET_RATE_HZ = 22050;
/** A bass note must hold at least this share of the bass energy to name a key-less loop's note. */
const DOMINANT_BASS_SHARE = 0.5;
/** A loop's length must be within this share of a whole number of bars to count as cut on the grid. */
const BAR_FIT_TOLERANCE = 0.035;
/** The tempo range a doubled or halved reading must fall in (BPM). */
const MIN_ALTERNATE_BPM = 60;
const MAX_ALTERNATE_BPM = 200;
/** A tempo reading at or under this may be a half-time reading of a fast loop (BPM). */
const HALF_TIME_BPM = 100;
/** A name's tempo agrees with the measured one (or its half or double) within this share. */
const HINT_AGREEMENT = 0.05;
/** The beat tracker's reading replaces a half-time one when it is this sure and within this share of double. */
const BEAT_TRACKER_CONFIDENCE = 0.5;
const BEAT_TRACKER_DOUBLE_TOLERANCE = 0.03;
/** MIDI notes and frequencies a one-shot's pitch may be reported at. */
const MIN_NOTE_HZ = 20;
const MAX_NOTE_HZ = 4200;
/** A one-shot is pitched when at least this share of its audible frames are voiced. */
const MIN_VOICED_SHARE = 0.6;
/** Categories whose sound has a note (a noisy hit's WAV note is ignored). */
const NOTE_CATEGORIES = new Set(['tonal', '808', 'kick', 'tom', 'vocal', 'perc']);

export interface AnalyzeOptions {
  /** The file's path in its folder: its name and folders hint the category, tempo and key. */
  path?: string;
  /** The real length when `channels` hold only the start of the file. */
  durationSec?: number;
  /** The MIDI note the file says it is tuned to (a WAV `smpl` unity note): the producer's word beats a pitch measurement. */
  rootKey?: number;
}

/** The block (5 ms, at least 16 frames) the onset search works in. */
const ONSET_BLOCK_SEC = 0.005;
const MIN_ONSET_BLOCK = 16;
/** Too short for the search: fewer blocks than this. */
const MIN_ONSET_BLOCKS = 12;
/** An onset is a block this far over the quietest of the 8 before it (dB)… */
const ONSET_RISE_DB = 9;
const ONSET_LOOKBACK_BLOCKS = 8;
/** …in a block no more than this far under the loudest (dB)… */
const ONSET_RANGE_DB = 40;
/** …and onsets are at least this many blocks apart (80 ms). */
const MIN_ONSET_SPACING_BLOCKS = 16;
/** The first difference of white noise is 3 dB louder than the noise: removed so both bands share a scale. */
const HIGH_PASS_NOISE_GAIN_DB = 3;
/** The two bands often find the same hit a block or two apart: closer than this (s) is one hit. */
const MERGE_ONSETS_SEC = 0.05;

const toDb = (v: number) => 20 * Math.log10(v + 1e-9);

/** The level of every block in dB: the peak envelope, and the high-passed copy (hats over a bass). */
function onsetLevels(
  x: Float32Array,
  block: number,
  blocks: number,
): { full: Float32Array; high: Float32Array; top: number } {
  const peak = peakEnvelope(x, block);
  const full = new Float32Array(blocks);
  let top = -200;
  for (let b = 0; b < blocks; b++) {
    full[b] = toDb(peak[b] as number);
    top = Math.max(top, full[b] as number);
  }
  // The high-passed copy (first difference) is 3 dB louder than the signal for white noise: compared on the same scale.
  const high = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    const from = b * block;
    let prev = from > 0 ? (x[from - 1] as number) : 0;
    for (let i = from; i < from + block; i++) {
      const v = (x[i] as number) - prev;
      prev = x[i] as number;
      sum += v * v;
    }
    high[b] = 10 * Math.log10(sum / block + 1e-12) - HIGH_PASS_NOISE_GAIN_DB;
  }
  return { full, high, top };
}

/** The start time (s) of every rise of 9 dB in one level curve that is within 40 dB of `top`. */
function risesIn(levels: Float32Array, top: number, block: number, sr: number): number[] {
  const blocks = levels.length;
  const times: number[] = [];
  let last = -1e9;
  for (let b = ONSET_LOOKBACK_BLOCKS; b < blocks; b++) {
    const v = levels[b] as number;
    if (v < top - ONSET_RANGE_DB) continue;
    let low = 1e9;
    for (let k = b - ONSET_LOOKBACK_BLOCKS; k < b; k++) low = Math.min(low, levels[k] as number);
    if (v - low >= ONSET_RISE_DB && v >= (levels[b + 1] ?? -200) - 3 && b - last >= MIN_ONSET_SPACING_BLOCKS) {
      // Walk forward to the local peak so a slow attack counts once.
      let p = b;
      while (p + 1 < blocks && (levels[p + 1] as number) >= (levels[p] as number)) p++;
      times.push((b * block) / sr);
      last = p;
    }
  }
  return times;
}

/**
 * Times (s) where a new sound starts: a rise of 9 dB in the level of the signal (a peak envelope, so a low note's ripple
 * is not a hit) or in its high-passed copy (hats over a bass), measured against the loudest moment of the signal.
 */
export function findOnsets(x: Float32Array, sr: number): number[] {
  const block = Math.max(MIN_ONSET_BLOCK, Math.round(sr * ONSET_BLOCK_SEC));
  const blocks = Math.floor(x.length / block);
  if (blocks < MIN_ONSET_BLOCKS) return [];
  const { full, high, top } = onsetLevels(x, block, blocks);
  const times = [...risesIn(full, top, block, sr), ...risesIn(high, top, block, sr)];
  times.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of times) {
    if (merged.length === 0 || t - (merged[merged.length - 1] as number) > MERGE_ONSETS_SEC) merged.push(t);
  }
  return merged;
}

/** The number of bars (from the usual loop lengths) that `durationSec` is at `bpm`, or null when it is not close to one. */
function wholeBarsAt(bpm: number, durationSec: number): number | null {
  const bars = (durationSec * bpm) / 240;
  const nearest = LOOP_BARS.reduce((best, n) => (Math.abs(n - bars) < Math.abs(best - bars) ? n : best), 1);
  return Math.abs(bars - nearest) <= BAR_FIT_TOLERANCE * Math.max(1, bars) ? nearest : null;
}

/**
 * The tempo to use when the file name states one: the name is the producer's word, taken when it fits
 * the length in whole bars, or is the measured tempo (or its half or double).
 */
function tempoWithNameHint(measured: number | null, hintBpm: number, durationSec: number): number {
  const isRelated =
    measured !== null && [1, 2, 0.5].some((m) => Math.abs(measured * m - hintBpm) / hintBpm < HINT_AGREEMENT);
  if (isRelated || measured === null || wholeBarsAt(hintBpm, durationSec) !== null) return hintBpm;
  return measured;
}

/** A half-time reading of a fast loop (drum and bass at 174 reads 87): the beat tracker knows where the drums sit. */
function doubledByBeatTracker(bpm: number, mono: Float32Array, sr: number): number {
  const decimation = Math.max(1, Math.floor(sr / TARGET_RATE_HZ));
  const beats = trackBeats(onsetFeatures(decimate(mono, decimation, sr), sr / decimation));
  if (!beats || beats.confidence < BEAT_TRACKER_CONFIDENCE) return bpm;
  const isDouble = Math.abs(beats.bpm - 2 * bpm) / (2 * bpm) < BEAT_TRACKER_DOUBLE_TOLERANCE;
  return isDouble ? beats.bpm : bpm;
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
  let bpm = detectTempo([mono], sr);
  if (hint.bpm !== undefined) bpm = tempoWithNameHint(bpm, hint.bpm, durationSec);
  else if (bpm !== null && bpm <= HALF_TIME_BPM) bpm = doubledByBeatTracker(bpm, mono, sr);
  if (bpm === null) return null;
  let bars = wholeBarsAt(bpm, durationSec);
  let tempo = bpm;
  if (bars === null) {
    for (const m of [2, 0.5]) {
      const alt = bpm * m;
      const altBars = alt >= MIN_ALTERNATE_BPM && alt <= MAX_ALTERNATE_BPM ? wholeBarsAt(alt, durationSec) : null;
      if (altBars !== null) {
        bars = altBars;
        tempo = alt;
        break;
      }
    }
  }
  return {
    bpm: Math.round(tempo * 10) / 10,
    bars: Math.max(1, Math.round(bars ?? (durationSec * tempo) / 240)),
    fitsBars: bars !== null,
  };
}

/** Categories whose names say the loop is drums. */
const DRUM_CATEGORIES = ['kick', 'snare', 'clap', 'hat', 'open-hat', 'cymbal', 'tom', 'perc'];
/** A bass loop keeps this share of its energy under 250 Hz, with a centroid under this (Hz). */
const BASS_LOW_SHARE = 0.8;
const BASS_CENTROID_HZ = 350;

/** What the loop is made of, from the energy it keeps low and whether it has a key. */
function loopKindOf(f: SoundFeatures, hasKey: boolean, hint: NameHint): LoopKind {
  // A name that says bass, drums or a melody settles it.
  if (hint.category === '808') return 'bass';
  if (hint.category && DRUM_CATEGORIES.includes(hint.category)) return 'drums';
  if (hint.category === 'tonal' || hint.category === 'vocal') return 'melodic';
  const low = (f.bands[0] as number) + (f.bands[1] as number);
  if (hasKey && low > BASS_LOW_SHARE && f.centroid < BASS_CENTROID_HZ) return 'bass';
  return hasKey ? 'melodic' : 'drums';
}

/** The pitch class that most of a signal's bass energy sits on (when it is at least half of it), else null. */
function dominantBassNote(c: Chromagram): number | null {
  const sum = new Float64Array(12);
  for (let f = 0; f < c.frames; f++) {
    for (let k = 0; k < 12; k++) sum[k] = (sum[k] as number) + (c.bass[f * 12 + k] as number);
  }
  const total = sum.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let best = 0;
  for (let k = 1; k < 12; k++) if ((sum[k] as number) > (sum[best] as number)) best = k;
  return (sum[best] as number) / total >= DOMINANT_BASS_SHARE ? best : null;
}

/** The numbers every result carries, whatever the kind of file. */
function levelOf(f: SoundFeatures) {
  return {
    loudnessDb: Math.round(f.loudnessDb * 10) / 10,
    peakDb: Math.round(f.peakDb * 10) / 10,
    brightness: Math.round(f.centroid),
  };
}

/** One-shot or loop: several hits at a steady tempo over a whole number of bars (or the file says so). */
function loopTempoIfLoop(
  mono: Float32Array,
  sampleRate: number,
  durationSec: number,
  hint: NameHint,
): { isLoop: boolean; tempo: ReturnType<typeof loopTempo> } {
  if (durationSec < MIN_LOOP_SEC || hint.kind === 'one-shot') return { isLoop: false, tempo: null };
  const isNamedLoop = hint.kind === 'loop' && durationSec >= MIN_NAMED_LOOP_SEC;
  if (findOnsets(mono, sampleRate).length < MIN_LOOP_ONSETS && !isNamedLoop) return { isLoop: false, tempo: null };
  const tempo = loopTempo(mono, sampleRate, durationSec, hint);
  return { isLoop: (tempo?.fitsBars ?? false) || isNamedLoop, tempo };
}

/** The analysis of a loop: tempo, bars, what it is made of and its key (from the signal, else the name, else a lone bass note). */
function analyzeLoop(
  mono: Float32Array,
  sampleRate: number,
  f: SoundFeatures,
  tempo: ReturnType<typeof loopTempo>,
  hint: NameHint,
  base: { v: number; durationSec: number },
): SampleAnalysis {
  const decimation = Math.max(1, Math.floor(sampleRate / TARGET_RATE_HZ));
  const chroma = chromagram(decimate(mono, decimation, sampleRate), sampleRate / decimation);
  const key = estimateKey(chroma);
  const hasKey = key !== null && key.confidence >= MIN_KEY_CONFIDENCE;
  let confidence = 0.3;
  if (tempo) confidence = tempo.fitsBars ? 0.85 : 0.5;
  const out: SampleAnalysis = {
    ...base,
    kind: 'loop',
    category: null,
    confidence,
    ...(tempo ? { bpm: tempo.bpm, bars: tempo.bars } : {}),
    loopKind: loopKindOf(f, hasKey, hint),
    ...levelOf(f),
    vec: fingerprint(f, 'loop'),
  };
  if (key && hasKey) {
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

/** The analysis of a one-shot: its category (signal and name) and the note it sounds at. */
function analyzeOneShot(
  f: SoundFeatures,
  hint: NameHint,
  opts: AnalyzeOptions,
  base: { v: number; durationSec: number },
): SampleAnalysis {
  const c = applyHint(classify(f), hint);
  const out: SampleAnalysis = {
    ...base,
    kind: 'one-shot',
    category: c.category,
    confidence: c.confidence,
    ...levelOf(f),
    vec: fingerprint(f, 'one-shot'),
    basis: c.basis,
  };
  const fileNote = opts.rootKey;
  const hasFileNote =
    fileNote !== undefined &&
    Number.isInteger(fileNote) &&
    fileNote >= 0 &&
    fileNote <= 127 &&
    (!out.category || NOTE_CATEGORIES.has(out.category));
  if (fileNote !== undefined && hasFileNote) {
    // The note it sounds at: the file's own word when it carries one (not for noisy hits).
    out.midi = fileNote;
    out.root = fileNote % 12;
    out.keyConfidence = 0.95;
  } else if (f.f0 > 0 && f.voiced >= MIN_VOICED_SHARE && f.f0 >= MIN_NOTE_HZ && f.f0 <= MAX_NOTE_HZ) {
    // Else its steady pitch (kicks and 808s are tuned too).
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

/** Analyzes decoded audio (`channels at `sampleRate`; only the first seconds are read). */
export function analyzeSample(
  channels: readonly Float32Array[],
  sampleRate: number,
  opts: AnalyzeOptions = {},
): SampleAnalysis {
  const frames = channels[0]?.length ?? 0;
  const durationSec = opts.durationSec ?? frames / sampleRate;
  const hint = opts.path ? nameHint(opts.path) : {};
  const mono = monoMix(channels, sampleRate, LOOP_ANALYSIS_SEC);
  const f = extractFeatures(mono, sampleRate, durationSec);
  const base = { v: SAMPLE_ANALYSIS_VERSION, durationSec: Math.round(durationSec * 1000) / 1000 };

  if (durationSec > LONG_SEC) {
    return { ...base, kind: 'long', category: null, confidence: 0, ...levelOf(f), vec: fingerprint(f, 'long') };
  }
  const { isLoop, tempo } = loopTempoIfLoop(mono, sampleRate, durationSec, hint);
  if (isLoop) return analyzeLoop(mono, sampleRate, f, tempo, hint, base);
  return analyzeOneShot(f, hint, opts, base);
}
