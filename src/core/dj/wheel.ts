/**
 * The Camelot wheel and what makes two songs mix well: harmonic distance (same key, a step around the
 * wheel, the relative major/minor, the +2 "energy boost"), tempo distance (with half- and double-time
 * matches) and an overall energy score per song. Pure; shared by the auto-mix planner, the library
 * (badge colors) and the Studio's view of the mix.
 */
import type { Camelot, TrackAnalysis, TrackKey } from './types';

/** A position on the Camelot wheel. */
export interface WheelPos {
  /** 1–12 */
  n: number;
  letter: 'A' | 'B';
}

/** Reads a Camelot code like "8A" (null when it is not one). */
export function parseCamelot(c: string): WheelPos | null {
  const m = /^(1[0-2]|[1-9])([AB])$/.exec(c.trim().toUpperCase());
  return m ? { n: Number(m[1]), letter: m[2] as 'A' | 'B' } : null;
}

const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Camelot code of a key: C major = 8B, A minor = 8A; each fifth up is one step clockwise. */
export function camelotOf(root: number, mode: 'major' | 'minor'): Camelot {
  const r = ((Math.round(root) % 12) + 12) % 12;
  // Major: C (0) = 8B, G (7) = 9B … n = (8 + 7·r) mod 12. Minor: A (9) = 8A.
  const fifths = mode === 'major' ? (r * 7) % 12 : (((r - 9) * 7) % 12 + 12) % 12;
  const n = ((7 + fifths) % 12) + 1;
  return `${n}${mode === 'major' ? 'B' : 'A'}` as Camelot;
}

/** "A minor", "E♭ major". */
export function keyName(k: Pick<TrackKey, 'root' | 'mode'>): string {
  return `${NOTE[((k.root % 12) + 12) % 12]} ${k.mode}`;
}

/** Steps around the wheel from a to b, −5…6 (clockwise positive). */
export function wheelSteps(a: number, b: number): number {
  const d = (((b - a) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

/** How one key moves to another on the Camelot wheel: how well the songs blend. */
export type HarmonicMove = 'same' | 'step' | 'relative' | 'boost' | 'diagonal' | 'clash' | 'unknown';

/** How the key moves from a to b (a key with low confidence counts as unknown). */
export function harmonicMove(a: TrackKey | null, b: TrackKey | null, minConfidence = 0.3): HarmonicMove {
  if (!a || !b || a.confidence < minConfidence || b.confidence < minConfidence) return 'unknown';
  const pa = parseCamelot(a.camelot);
  const pb = parseCamelot(b.camelot);
  if (!pa || !pb) return 'unknown';
  const steps = wheelSteps(pa.n, pb.n);
  if (pa.letter === pb.letter) {
    if (steps === 0) return 'same';
    if (Math.abs(steps) === 1) return 'step';
    if (steps === 2) return 'boost';
    return 'clash';
  }
  if (steps === 0) return 'relative';
  if (Math.abs(steps) === 1) return 'diagonal';
  return 'clash';
}

/** Cost of a key move for ordering (0 best). The boost is allowed but kept rare. */
export const HARMONIC_COST: Record<HarmonicMove, number> = {
  same: 0,
  step: 1,
  relative: 1,
  unknown: 2,
  boost: 3,
  diagonal: 3.5,
  clash: 7,
};

/** The largest share a song may be sped up or slowed down by in a beat-matched transition (follow mode). */
export const TEMPO_LIMIT = 0.06;

/** How to play a song at a tempo near another's: the half/double factor and how far each song moves. */
export interface TempoMatch {
  /** The incoming song plays at `bpm × factor` beats: 1 normally, 0.5 or 2 for a half/double-time match. */
  factor: 0.5 | 1 | 2;
  /** max(b′/a, a/b′) − 1 for the effective tempo b′ = b × factor: how far either song moves to meet the other. */
  deviation: number;
}

/** The best way to beat-match a song at `b` BPM to one at `a`: straight when it is close enough, else half or double time. */
export function tempoMatch(a: number, b: number, limit = TEMPO_LIMIT): TempoMatch {
  // Symmetric: neither song may move further than the limit from its own tempo.
  const dev = (f: number) => Math.max((b * f) / a, a / (b * f)) - 1;
  if (dev(1) <= limit) return { factor: 1, deviation: dev(1) };
  const best = ([1, 0.5, 2] as const).reduce((x, f) => (dev(f) < dev(x) ? f : x), 1 as 0.5 | 1 | 2);
  return { factor: best, deviation: dev(best) };
}

/** Cost of a tempo change for ordering: 0 for the same tempo, 3 at the limit, much more past it (only a cut works then). */
export function tempoCost(m: TempoMatch, limit = TEMPO_LIMIT): number {
  const base = m.deviation <= limit ? (m.deviation / limit) * 3 : 8 + m.deviation * 20;
  return base + (m.factor === 1 ? 0 : 1);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * A song's overall energy, 0–1, comparable between songs: louder, faster and with more high-energy
 * bars is more. (The analysis's per-bar energy is relative within a song.)
 */
export function trackEnergy(a: Pick<TrackAnalysis, 'lufs' | 'grid' | 'energy'>): number {
  const loud = Number.isFinite(a.lufs) ? clamp01((a.lufs + 18) / 12) : 0.5;
  const bpm = a.grid?.bpm ?? 110;
  const tempo = clamp01((bpm - 85) / 60);
  const bars = a.energy.length ? a.energy.filter((e) => e > 0.6).length / a.energy.length : 0.5;
  return Math.round((0.4 * loud + 0.35 * tempo + 0.25 * bars) * 1000) / 1000;
}

/**
 * A position on the wheel as a hue for the key badge (the Camelot convention: 1 = cyan-green round
 * to 12; minor darker). Returns [hue 0–360, lightness %].
 */
export function camelotHue(c: string): [number, number] | null {
  const p = parseCamelot(c);
  if (!p) return null;
  return [((p.n - 1) * 30 + 150) % 360, p.letter === 'A' ? 52 : 64];
}
