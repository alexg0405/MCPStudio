import type { Note, NoteId, Tick } from '../model/types';
import { lowerBound, maxNoteLength } from './queries';

/** The note under (tick, key), preferring the one that started last (it's drawn on top). */
export function noteAt(notes: readonly Note[], tick: number, key: number): Note | undefined {
  const start = lowerBound(notes, tick - maxNoteLength(notes));
  let hit: Note | undefined;
  for (let i = start; i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.tick > tick) break;
    if (n.key === key && tick < n.tick + n.length) hit = n;
  }
  return hit;
}

/** Notes intersecting the tick range [t0, t1) and key range [k0, k1] (inclusive keys). */
export function notesInRect(notes: readonly Note[], t0: Tick, t1: Tick, k0: number, k1: number): NoteId[] {
  const lo = Math.min(k0, k1);
  const hi = Math.max(k0, k1);
  const out: NoteId[] = [];
  const start = lowerBound(notes, t0 - maxNoteLength(notes));
  for (let i = start; i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.tick >= t1) break;
    if (n.tick + n.length > t0 && n.key >= lo && n.key <= hi) out.push(n.id);
  }
  return out;
}

/** Bounds of a set of notes, or null for none. */
export function noteBounds(notes: readonly Note[]): { start: Tick; end: Tick; low: number; high: number } | null {
  if (notes.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  let low = 127;
  let high = 0;
  for (const n of notes) {
    start = Math.min(start, n.tick);
    end = Math.max(end, n.tick + n.length);
    low = Math.min(low, n.key);
    high = Math.max(high, n.key);
  }
  return { start, end, low, high };
}
