/**
 * Chord detection: which chord a handful of notes (or one frame of audio chroma) make. The notes of a stretch of time
 * are summed into twelve pitch-class weights; every root × quality is scored by how much of the weight falls on its notes,
 * how much falls outside them and which of its notes are missing; the bass breaks ties (C/E is a C chord on its third).
 * Pure, no DOM.
 */
import { chordPitchClasses, mod12, QUALITIES, sameChord, type ChordSymbol } from './chord';

/** A chord found in some notes, with how sure the reading is (0..1). */
export interface Detected {
  chord: ChordSymbol;
  /** 0–1: how well the notes fit and how far ahead of the next different reading this one is. */
  confidence: number;
}

/** How much each kind of chord tone matters to the reading (the fifth is the one most often left out). */
function toneWeight(interval: number): number {
  const i = interval % 12;
  if (i === 0) return 1;
  if (i === 3 || i === 4 || i === 2 || i === 5) return 0.9;
  if (i === 7 || i === 6 || i === 8) return 0.35;
  return 0.8;
}

/** A small preference for the chords songs are mostly made of. */
const PRIOR: Record<string, number> = {
  maj: 0.03,
  min: 0.03,
  '7': 0.015,
  maj7: 0.015,
  m7: 0.015,
  '5': -0.02,
  sus2: -0.02,
  sus4: -0.02,
};

const CANDIDATES = QUALITIES.filter((q) => !q.noDetect);

/** Pitch-class set of a candidate as a 12-bit mask (readings with the same notes have the same mask). */
const maskOf = (c: ChordSymbol): number => chordPitchClasses(c).reduce((m, pc) => m | (1 << pc), 0);

/** Settings of chord detection: how loud a pitch class must be, next to the loudest one, to count at all. */
export interface DetectOptions {
  /** Weights below this share of the loudest pitch class are treated as absent (default 0.08; use more for audio). */
  floor?: number;
}

/**
 * The chord that best explains twelve pitch-class weights, or null when fewer than two pitch classes sound (one note is
 * not a chord). `bass` is the pitch class of the lowest note, when known.
 */
export function detectChordFromWeights(
  weights: ArrayLike<number>,
  bass: number | null = null,
  opts: DetectOptions = {},
): Detected | null {
  const share = pitchClassShares(weights, opts.floor ?? DEFAULT_FLOOR);
  if (!share) return null;
  const scored: ScoredChord[] = [];
  for (let root = 0; root < 12; root++) {
    for (const quality of CANDIDATES) {
      const chord: ChordSymbol = { root, quality: quality.id };
      scored.push({ chord, score: scoreReading(share, root, quality, bass), mask: maskOf(chord) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  const rival = scored.find((x) => x.mask !== best.mask);
  const margin = best.score - (rival?.score ?? 0);
  const fit = clamp01(best.score);
  const confidence = fit * (0.55 + 0.45 * clamp01(margin / MARGIN_FOR_FULL_CONFIDENCE));
  const chord = { ...best.chord };
  if (bass !== null && mod12(bass) !== chord.root && chordPitchClasses(chord).includes(mod12(bass)))
    chord.bass = mod12(bass);
  return { chord, confidence: Math.round(confidence * 100) / 100 };
}

/** The default for `DetectOptions.floor`. */
const DEFAULT_FLOOR = 0.08;
/** A reading this far ahead of the next different one is fully confident. */
const MARGIN_FOR_FULL_CONFIDENCE = 0.25;
/** A chord tone with less than this share of the weight is hardly there (it costs a quarter of its importance)… */
const HARDLY_THERE = 0.04;
/** …and one with less than this is there only a little (it costs less). */
const THERE_A_LITTLE = 0.1;
/** Sounding weight outside the chord counts against it at this rate. */
const OUTSIDE_PENALTY = 0.9;
/** The bass on the root helps a reading; on another chord tone, a little; on something else it hurts. */
const BASS_ON_ROOT = 0.12;
const BASS_ON_TONE = 0.03;
const BASS_OFF_CHORD = -0.08;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface ScoredChord {
  chord: ChordSymbol;
  score: number;
  mask: number;
}

/**
 * The twelve weights as shares of their sum, ignoring those under `floor` × the loudest; null when fewer than
 * two pitch classes are left (one note is not a chord).
 */
function pitchClassShares(weights: ArrayLike<number>, floorShare: number): Float64Array | null {
  let max = 0;
  for (let i = 0; i < 12; i++) max = Math.max(max, weights[i] ?? 0);
  if (!(max > 0)) return null;
  const floor = floorShare * max;
  const share = new Float64Array(12);
  let total = 0;
  let present = 0;
  for (let i = 0; i < 12; i++) {
    const weight = weights[i] ?? 0;
    if (weight >= floor) {
      share[i] = weight;
      total += weight;
      present++;
    }
  }
  if (present < 2) return null;
  for (let i = 0; i < 12; i++) share[i] = (share[i] as number) / total;
  return share;
}

/** How well the shares fit a chord on `root` with this quality: weight inside it, minus the outside and the missing tones, plus the bass. */
function scoreReading(
  share: Float64Array,
  root: number,
  quality: (typeof CANDIDATES)[number],
  bass: number | null,
): number {
  const tones = new Map<number, number>();
  for (const interval of quality.intervals) {
    const pc = mod12(root + interval);
    if (!tones.has(pc)) tones.set(pc, toneWeight(interval));
  }
  let inside = 0;
  let missing = 0;
  for (const [pc, toneImportance] of tones) {
    const have = share[pc] as number;
    inside += have;
    // A tone that is hardly there costs its weight; one that is there a little costs less.
    if (have < HARDLY_THERE) missing += toneImportance * 0.25;
    else if (have < THERE_A_LITTLE) missing += toneImportance * 0.08;
  }
  const outside = 1 - inside;
  let score = inside - OUTSIDE_PENALTY * outside - missing + (PRIOR[quality.id] ?? 0);
  if (bass !== null) {
    if (mod12(bass) === root) score += BASS_ON_ROOT;
    else if (tones.has(mod12(bass))) score += BASS_ON_TONE;
    else score += BASS_OFF_CHORD;
  }
  return score;
}

/** A note as detection reads it (song or pattern ticks, MIDI key, velocity 0–1). */
export interface HarmonyNote {
  tick: number;
  length: number;
  key: number;
  velocity: number;
}

/** A detected stretch of the chord track. */
export interface DetectedSpan {
  tick: number;
  length: number;
  chord: ChordSymbol;
  confidence: number;
}

/**
 * How to cut a stretch of notes into windows and read a chord from each: the range and bar length (ticks), the window
 * size and the confidence needed to keep a reading.
 */
export interface DetectSpansOptions {
  /** Where to start, in ticks (default: the bar the first note is in). */
  from?: number;
  /** Where to stop (default: the end of the last note). */
  to?: number;
  /** Ticks per bar. */
  bar: number;
  /** A window per bar, or per half bar (default bar). */
  resolution?: 'bar' | 'half';
  /** Readings below this confidence are left as gaps (default 0.3). */
  minConfidence?: number;
}

/**
 * Chords of a stretch of notes, one reading per window (bar or half bar); neighbours with the same chord become one span.
 * A window with fewer than two pitch classes (a lone bass note, silence) has no chord. At half-bar resolution a bar whose
 * halves read the same is one span.
 */
export function detectSpans(notes: readonly HarmonyNote[], opts: DetectSpansOptions): DetectedSpan[] {
  if (notes.length === 0) return [];
  const bar = Math.max(1, Math.round(opts.bar));
  const win = opts.resolution === 'half' ? Math.max(1, Math.round(bar / 2)) : bar;
  const first = Math.min(...notes.map((n) => n.tick));
  const last = Math.max(...notes.map((n) => n.tick + n.length));
  const from = Math.max(0, opts.from ?? Math.floor(first / bar) * bar);
  const to = opts.to ?? Math.ceil(last / bar) * bar;
  const minConf = opts.minConfidence ?? 0.3;
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const out: DetectedSpan[] = [];
  const weights = new Float64Array(12);
  for (let t = from; t < to; t += win) {
    const end = Math.min(to, t + win);
    weights.fill(0);
    let lowest = Infinity;
    let lowestLen = 0;
    for (const n of sorted) {
      if (n.tick >= end) break;
      const overlap = Math.min(end, n.tick + n.length) - Math.max(t, n.tick);
      if (overlap <= 0) continue;
      const w = overlap * (0.4 + 0.6 * Math.max(0, Math.min(1, n.velocity)));
      weights[mod12(n.key)] = (weights[mod12(n.key)] as number) + w;
      // The bass: the lowest note that sounds for a fair part of the window.
      if (overlap >= Math.min((end - t) * 0.25, 480) && n.key < lowest) {
        lowest = n.key;
        lowestLen = overlap;
      }
    }
    const d = detectChordFromWeights(weights, lowestLen > 0 ? mod12(lowest) : null);
    if (!d || d.confidence < minConf) continue;
    addSpan(out, t, end - t, d);
  }
  return out;
}

/** Adds a reading as a span, or lengthens the last span when it is the same chord right next to it (the confidences average by length). */
function addSpan(spans: DetectedSpan[], tick: number, length: number, d: Detected): void {
  const prev = spans[spans.length - 1];
  if (!prev || prev.tick + prev.length !== tick || !sameChord(prev.chord, d.chord)) {
    spans.push({ tick, length, chord: d.chord, confidence: d.confidence });
    return;
  }
  const total = prev.length + length;
  prev.confidence = Math.round(((prev.confidence * prev.length + d.confidence * length) / total) * 100) / 100;
  prev.length = total;
}

/** One frame of audio chroma: twelve weights for the whole sound and twelve for its low end. */
export interface ChromaWindow {
  tick: number;
  length: number;
  chroma: ArrayLike<number>;
  bass?: ArrayLike<number>;
}

/** Chords from audio chroma windows (the DJ chromagram summed over a bar or half bar), with the same merging as notes. */
export function detectSpansFromChroma(windows: readonly ChromaWindow[], minConfidence = 0.3): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const w of windows) {
    const d = detectChordFromWeights(w.chroma, w.bass ? bassOfChroma(w.bass) : null, { floor: CHROMA_FLOOR });
    if (!d || d.confidence < minConfidence) continue;
    addSpan(out, w.tick, w.length, d);
  }
  return out;
}

/** Audio chroma is noisier than notes: weights under this share of the loudest pitch class are absent. */
const CHROMA_FLOOR = 0.28;
/** The low end names the bass only when its loudest pitch class holds at least this share of it. */
const BASS_CLEAR_SHARE = 0.3;

/** The pitch class the low end of a chroma window is on, or null when it is flat (a flat low end says nothing). */
function bassOfChroma(bassChroma: ArrayLike<number>): number | null {
  let bass: number | null = null;
  let top = 0;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const v = bassChroma[i] ?? 0;
    sum += v;
    if (v > top) {
      top = v;
      bass = i;
    }
  }
  return !(sum > 0) || top < BASS_CLEAR_SHARE * sum ? null : bass;
}

/** The plain name of how sure a reading is, for menus and the AI. */
export const confidenceWord = (c: number): 'sure' | 'likely' | 'unsure' =>
  c >= 0.75 ? 'sure' : c >= 0.5 ? 'likely' : 'unsure';
