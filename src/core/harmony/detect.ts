/**
 * Chord detection: which chord a handful of notes (or one frame of audio chroma) make. The notes of a stretch of time
 * are summed into twelve pitch-class weights; every root × quality is scored by how much of the weight falls on its notes,
 * how much falls outside them and which of its notes are missing; the bass breaks ties (C/E is a C chord on its third).
 * Pure, no DOM.
 */
import { chordPitchClasses, mod12, QUALITIES, sameChord, type ChordSymbol } from './chord';

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
const PRIOR: Record<string, number> = { maj: 0.03, min: 0.03, '7': 0.015, maj7: 0.015, m7: 0.015, '5': -0.02, sus2: -0.02, sus4: -0.02 };

const CANDIDATES = QUALITIES.filter((q) => !q.noDetect);

/** Pitch-class set of a candidate as a 12-bit mask (readings with the same notes have the same mask). */
const maskOf = (c: ChordSymbol): number => chordPitchClasses(c).reduce((m, pc) => m | (1 << pc), 0);

export interface DetectOptions {
  /** Weights below this share of the loudest pitch class are treated as absent (default 0.08; use more for audio). */
  floor?: number;
}

/**
 * The chord that best explains twelve pitch-class weights, or null when fewer than two pitch classes sound (one note is
 * not a chord). `bass` is the pitch class of the lowest note, when known.
 */
export function detectChordFromWeights(weights: ArrayLike<number>, bass: number | null = null, opts: DetectOptions = {}): Detected | null {
  let max = 0;
  for (let i = 0; i < 12; i++) max = Math.max(max, weights[i] ?? 0);
  if (!(max > 0)) return null;
  const floor = (opts.floor ?? 0.08) * max;
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

  const scored: { chord: ChordSymbol; score: number; mask: number }[] = [];
  for (let root = 0; root < 12; root++) {
    for (const quality of CANDIDATES) {
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
        if (have < 0.04) missing += toneImportance * 0.25;
        else if (have < 0.1) missing += toneImportance * 0.08;
      }
      const outside = 1 - inside;
      let score = inside - 0.9 * outside - missing + (PRIOR[quality.id] ?? 0);
      if (bass !== null) {
        if (mod12(bass) === root) score += 0.12;
        else if (tones.has(mod12(bass))) score += 0.03;
        else score -= 0.08;
      }
      const chord: ChordSymbol = { root, quality: quality.id };
      scored.push({ chord, score, mask: maskOf(chord) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  const rival = scored.find((x) => x.mask !== best.mask);
  const margin = best.score - (rival?.score ?? 0);
  const fit = Math.max(0, Math.min(1, best.score));
  const confidence = fit * (0.55 + 0.45 * Math.max(0, Math.min(1, margin / 0.25)));
  const chord = { ...best.chord };
  if (bass !== null && mod12(bass) !== chord.root && chordPitchClasses(chord).includes(mod12(bass))) chord.bass = mod12(bass);
  return { chord, confidence: Math.round(confidence * 100) / 100 };
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
    const prev = out[out.length - 1];
    if (prev && prev.tick + prev.length === t && sameChord(prev.chord, d.chord)) {
      const total = prev.length + (end - t);
      prev.confidence = Math.round(((prev.confidence * prev.length + d.confidence * (end - t)) / total) * 100) / 100;
      prev.length = total;
    } else out.push({ tick: t, length: end - t, chord: d.chord, confidence: d.confidence });
  }
  return out;
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
    let bass: number | null = null;
    if (w.bass) {
      let top = 0;
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        const v = w.bass[i] ?? 0;
        sum += v;
        if (v > top) {
          top = v;
          bass = i;
        }
      }
      // A flat low end says nothing.
      if (!(sum > 0) || top < 0.3 * sum) bass = null;
    }
    const d = detectChordFromWeights(w.chroma, bass, { floor: 0.28 });
    if (!d || d.confidence < minConfidence) continue;
    const prev = out[out.length - 1];
    if (prev && prev.tick + prev.length === w.tick && sameChord(prev.chord, d.chord)) {
      const total = prev.length + w.length;
      prev.confidence = Math.round(((prev.confidence * prev.length + d.confidence * w.length) / total) * 100) / 100;
      prev.length = total;
    } else out.push({ tick: w.tick, length: w.length, chord: d.chord, confidence: d.confidence });
  }
  return out;
}

/** The plain name of how sure a reading is, for menus and the AI. */
export const confidenceWord = (c: number): 'sure' | 'likely' | 'unsure' => (c >= 0.75 ? 'sure' : c >= 0.5 ? 'likely' : 'unsure');

