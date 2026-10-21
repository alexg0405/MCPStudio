/** Small helpers the MIDI effects share: making a note from another one, keeping keys and velocities in range. */
import type { FxNote } from './types';

/** The lowest and highest MIDI keys. */
export const MIN_KEY = 0;
export const MAX_KEY = 127;
/** The quietest velocity a note keeps (a velocity of 0 would read as a note-off). */
export const MIN_VELOCITY = 0.01;
/** A start or end compared within this many ticks counts as equal (starts come out of sums of fractions). */
export const TICK_EPSILON = 1e-6;

/** True when `key` is a playable MIDI key. */
export function isPlayableKey(key: number): boolean {
  return key >= MIN_KEY && key <= MAX_KEY;
}

/** A velocity kept between the quietest allowed and full. */
export function clampVelocity(velocity: number): number {
  return Math.max(MIN_VELOCITY, Math.min(1, velocity));
}

/** The fields of a note an effect may change when it makes a new note from it. */
export type NoteChange = Partial<Pick<FxNote, 'start' | 'end' | 'key' | 'velocity'>>;

/**
 * A new note with the given id, made from `source`: it keeps the source's pan, fine pitch and release, and takes the changes.
 * Effects that make notes from nothing in particular (an arpeggiator's steps) choose their own ids.
 */
export function noteLike(id: string, source: FxNote, change: NoteChange): FxNote {
  const note: FxNote = {
    id,
    start: change.start ?? source.start,
    end: change.end ?? source.end,
    key: change.key ?? source.key,
    velocity: change.velocity ?? source.velocity,
  };
  if (source.pan !== undefined) note.pan = source.pan;
  if (source.fine !== undefined) note.fine = source.fine;
  if (source.release !== undefined) note.release = source.release;
  return note;
}

/**
 * A new note made from `source` with the given changes; its id is the source's id plus `tag`, so the same source and the same
 * effect always make notes with the same ids.
 */
export function derivedNote(source: FxNote, tag: string, change: NoteChange): FxNote {
  return noteLike(`${source.id}:${tag}`, source, change);
}

/** A copy of `source` with changes and the same id (the note stays "the same note", only moved or restyled). */
export function changedNote(source: FxNote, change: NoteChange): FxNote {
  return { ...source, ...change };
}

/** Orders notes by start, then by key, then by id, so equal runs always list notes the same way. */
export function byStartThenKey(a: FxNote, b: FxNote): number {
  return a.start - b.start || a.key - b.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
