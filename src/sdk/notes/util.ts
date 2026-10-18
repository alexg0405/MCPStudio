/**
 * Small helpers shared by the note transforms. Notes are `ScriptNote`s (ticks at PPQ 960). Every
 * transform returns new objects and never mutates its input.
 */
import type { ScriptNote } from '../types';
import { Rng } from '../dsp/random';

/** A random number source in [0, 1): `ctx.rand` in a note script, or `seeded(n)`. */
export type Rand = () => number;

/** A deterministic random source (mulberry32): the same seed gives the same sequence. */
export function seeded(seed: number): Rand {
  const rng = new Rng(Math.round(seed) | 0);
  return () => rng.next();
}

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** Limits `v` to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** End tick (exclusive). */
export function noteEnd(n: { readonly tick: number; readonly length: number }): number {
  return n.tick + n.length;
}

/**
 * A valid copy of a note: integer tick ≥ 0, integer length ≥ 1, integer key 0–127, velocity 0–1,
 * pan −1…1, release 0–1, fine −100…100 (cents). Non-finite numbers fall back to safe values.
 */
export function clampNote(n: ScriptNote): ScriptNote {
  const out: ScriptNote = {
    ...n,
    tick: Math.max(0, Math.round(finite(n.tick, 0))),
    length: Math.max(1, Math.round(finite(n.length, 1))),
    // `+ 0` turns −0 into 0.
    key: clamp(Math.round(finite(n.key, 60)), 0, 127) + 0,
    velocity: clamp(finite(n.velocity, 0.78), 0, 1) + 0,
  };
  if (n.pan !== undefined) out.pan = clamp(finite(n.pan, 0), -1, 1);
  if (n.release !== undefined) out.release = clamp(finite(n.release, 0.5), 0, 1);
  if (n.fine !== undefined) out.fine = clamp(finite(n.fine, 0), -100, 100);
  return out;
}

/** A copy without `id`: the host adds it as a new note. */
export function withoutId(n: ScriptNote): ScriptNote {
  const { id: _id, ...rest } = n;
  return rest;
}

/** A copy sorted by start, then key. */
export function byTime(notes: readonly ScriptNote[]): ScriptNote[] {
  return [...notes].sort((a, b) => a.tick - b.tick || a.key - b.key);
}

/** The time and key range a set of notes covers. */
export interface Span {
  /** First start. */
  start: number;
  /** Last end (exclusive). */
  end: number;
  /** Lowest and highest key. */
  low: number;
  high: number;
}

/** The time and key range the notes cover, or null for no notes. */
export function span(notes: readonly ScriptNote[]): Span | null {
  if (notes.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  let low = Infinity;
  let high = -Infinity;
  for (const n of notes) {
    if (n.tick < start) start = n.tick;
    if (noteEnd(n) > end) end = noteEnd(n);
    if (n.key < low) low = n.key;
    if (n.key > high) high = n.key;
  }
  return { start, end, low, high };
}

/**
 * Chords: notes that start together. A note joins the group when it starts within `tolerance`
 * ticks of the group's first note. Groups are in time order, notes in each by key.
 */
export function chordGroups(notes: readonly ScriptNote[], tolerance = 0): ScriptNote[][] {
  const groups: ScriptNote[][] = [];
  let current: ScriptNote[] | null = null;
  for (const n of byTime(notes)) {
    if (current && n.tick - (current[0] as ScriptNote).tick <= tolerance) current.push(n);
    else groups.push((current = [n]));
  }
  for (const g of groups) g.sort((a, b) => a.key - b.key);
  return groups;
}

/** Notes that overlap in time, chained (a held chord, a rolled chord, legato phrases). */
export function overlapGroups(notes: readonly ScriptNote[]): ScriptNote[][] {
  const groups: ScriptNote[][] = [];
  let current: ScriptNote[] | null = null;
  let end = -Infinity;
  for (const n of byTime(notes)) {
    if (current && n.tick < end) {
      current.push(n);
      end = Math.max(end, noteEnd(n));
    } else {
      groups.push((current = [n]));
      end = noteEnd(n);
    }
  }
  return groups;
}

/**
 * Bends 0–1 → 0–1: curve 0 is a straight line, positive curves start slow and end fast,
 * negative curves the opposite.
 */
export function bend(x: number, curve: number): number {
  const t = clamp(x, 0, 1);
  const c = clamp(curve, -1, 1);
  return c >= 0 ? Math.pow(t, 1 + 3 * c) : 1 - Math.pow(1 - t, 1 - 3 * c);
}
