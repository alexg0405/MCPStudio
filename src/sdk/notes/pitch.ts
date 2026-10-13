/**
 * Pitch transforms: transpose (semitones or scale steps), snap to a scale, limit to a range and
 * turn notes into chords.
 */
import type { ScriptNote } from '../types';
import { chordNotes, diatonicChord, type Voicing } from './chords';
import { snapToScale, transposeInScale, type KeyLike } from './scales';
import { clamp, span, withoutId } from './util';

/**
 * Moves notes by semitones. The shift is limited so that no note leaves 0–127, which keeps the
 * intervals between the notes.
 */
export function transpose(notes: readonly ScriptNote[], semitones: number): ScriptNote[] {
  const s = span(notes);
  if (!s) return [];
  const by = clamp(Math.round(semitones), -s.low, 127 - s.high);
  return notes.map((n) => ({ ...n, key: n.key + by }));
}

/**
 * Moves notes by steps of a scale (+2 = up a third in the key). Notes outside the scale keep their
 * distance above the scale note below them. Like `transpose`, the shift shrinks rather than push a
 * note out of 0–127.
 */
export function transposeDegrees(notes: readonly ScriptNote[], steps: number, key: KeyLike): ScriptNote[] {
  const target = Math.round(steps);
  const dir = Math.sign(target);
  for (let m = target; ; m -= dir) {
    const keys = notes.map((n) => transposeInScale(n.key, m, key.root, key.scale));
    if (m === 0 || keys.every((k) => k >= 0 && k <= 127))
      return notes.map((n, i) => ({ ...n, key: keys[i] as number }));
  }
}

/** Moves every note onto the scale (see `snapToScale`). */
export function snapNotesToScale(
  notes: readonly ScriptNote[],
  key: KeyLike,
  direction: 'nearest' | 'up' | 'down' = 'nearest',
): ScriptNote[] {
  return notes.map((n) => ({ ...n, key: snapToScale(n.key, key.root, key.scale, direction) }));
}

/** Keeps keys within [low, high] by moving notes outside it by octaves (clamps when the range is under an octave). */
export function limit(notes: readonly ScriptNote[], range: { low: number; high: number }): ScriptNote[] {
  const low = clamp(Math.round(Math.min(range.low, range.high)), 0, 127);
  const high = clamp(Math.round(Math.max(range.low, range.high)), 0, 127);
  return notes.map((n) => {
    let k = n.key;
    if (high - low >= 11) {
      while (k > high) k -= 12;
      while (k < low) k += 12;
    }
    return { ...n, key: clamp(k, low, high) };
  });
}

export interface ChordifyOptions {
  /** A chord id from `CHORDS`, or 'diatonic' to build the chord from the scale of `key`. */
  chord: string;
  /** Diatonic chords: 3 = triads, 4 = seventh chords, 5 = ninths (default 3). */
  size?: number;
  inversion?: number;
  voicing?: Voicing;
  /** The key for diatonic chords (default C major). */
  key?: KeyLike | null;
}

/**
 * Turns every note into a chord on its key. The chord note at the original key (or the lowest one)
 * keeps the note's id; the other chord notes are new.
 */
export function chordify(notes: readonly ScriptNote[], opts: ChordifyOptions): ScriptNote[] {
  const out: ScriptNote[] = [];
  for (const n of notes) {
    const keys =
      opts.chord === 'diatonic'
        ? diatonicChord(n.key, opts.key?.root ?? 0, opts.key?.scale ?? 'major', opts.size ?? 3, opts)
        : chordNotes(n.key, opts.chord, opts);
    const keep = keys.includes(n.key) ? n.key : keys[0];
    for (const k of keys) out.push(k === keep ? { ...n, key: k } : { ...withoutId(n), key: k });
  }
  return out;
}
