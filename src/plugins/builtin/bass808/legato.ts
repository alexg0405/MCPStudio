/**
 * Mono legato note tracking for the 808 (pure logic, no Web Audio; unit-tested in Node).
 *
 * The host sends note events ahead of time, and not always in time order: the scheduler dispatches
 * every note-on of a window before that window's note-offs, swing and several clips can reorder
 * note-ons, and live edits cancel notes (a note-off at or before its note-on). So "glide or
 * retrigger?" is never decided once, when a note-on arrives. The tracker keeps every known note and
 * derives the whole mono performance from them again after each event; the instrument then
 * reschedules only from the first point where the new performance differs from the old one.
 *
 * Rules:
 * - A note that starts while the current note is still held (its note-off is later, or unknown)
 *   glides: no new attack, and it becomes the current note (the old note's note-off is ignored).
 * - Otherwise it attacks (retriggers). Touching notes (end == next start) retrigger.
 * - Notes that start together are one note: the lowest key wins (then the lowest id).
 */

/** Overlaps shorter than this (floating-point noise from tick → time conversion) count as touching. */
export const OVERLAP_EPS = 1e-6;

export interface TrackedNote {
  /** The host's noteId (a re-used id gets a private negative id for the older note). */
  id: number;
  readonly key: number;
  readonly velocity: number;
  readonly start: number;
  /** Note-off time, or Infinity while unknown. */
  end: number;
}

export interface NoteAction {
  readonly type: 'attack' | 'glide';
  readonly time: number;
  readonly id: number;
  readonly key: number;
  readonly velocity: number;
}

export interface ReleaseAction {
  readonly type: 'release';
  readonly time: number;
  readonly id: number;
}

/** attack: a fresh hit (new voice, punch, click). glide: slide the current voice. release: end it. */
export type LegatoAction = NoteAction | ReleaseAction;

/** One voice's worth of performance: an attack, the notes that glide out of it, and its release. */
export interface Phrase {
  /** Starts with the attack; times never decrease. The release is missing while the last note is held. */
  readonly actions: readonly LegatoAction[];
  /** Every note the phrase covers, including ones hidden by a simultaneous note. */
  readonly ids: readonly number[];
}

/** Whether two actions are the same event (type, time, note and, for notes, key and velocity). */
export function sameAction(a: LegatoAction, b: LegatoAction): boolean {
  if (a.type !== b.type || a.time !== b.time || a.id !== b.id) return false;
  if (a.type === 'release' || b.type === 'release') return true;
  return a.key === b.key && a.velocity === b.velocity;
}

/**
 * The earliest time at which two performances (flattened, time-ordered action lists) differ, or
 * Infinity when they are the same. Everything before it is identical in both.
 */
export function firstDifference(a: readonly LegatoAction[], b: readonly LegatoAction[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x && y && sameAction(x, y)) continue;
    return Math.min(x?.time ?? Infinity, y?.time ?? Infinity);
  }
  return Infinity;
}

/**
 * Builds the phrases of a time-ordered list of notes, one note at a time (see `LegatoTracker.phrases`): a note that
 * starts together with the current one is hidden behind it, one that starts while the current note is still held
 * glides, and any other starts a new phrase with an attack.
 */
class PhraseBuilder {
  private readonly phrases: Phrase[] = [];
  private actions: LegatoAction[] = [];
  private ids: number[] = [];
  private current: TrackedNote | null = null;

  add(note: TrackedNote): void {
    const current = this.current;
    if (current && note.start - current.start <= OVERLAP_EPS) {
      // Starts together with the current note: hidden behind it.
      this.ids.push(note.id);
      return;
    }
    const action = { time: note.start, id: note.id, key: note.key, velocity: note.velocity };
    if (current && current.end - note.start > OVERLAP_EPS) {
      this.actions.push({ type: 'glide', ...action });
    } else {
      this.closePhrase(note.start);
      this.actions.push({ type: 'attack', ...action });
    }
    this.ids.push(note.id);
    this.current = note;
  }

  /** Closes the last phrase and returns them all. */
  finish(): Phrase[] {
    this.closePhrase(Infinity);
    return this.phrases;
  }

  /**
   * Ends the open phrase. `nextAttack` is the time of the following attack: a release that touches it within
   * OVERLAP_EPS is moved onto it so the flattened action list stays time-ordered.
   */
  private closePhrase(nextAttack: number): void {
    const current = this.current;
    if (!current) return;
    if (current.end < Infinity) {
      this.actions.push({ type: 'release', time: Math.min(current.end, nextAttack), id: current.id });
    }
    this.phrases.push({ actions: this.actions, ids: this.ids });
    this.actions = [];
    this.ids = [];
  }
}

/** The tracked notes of the 808, and the mono performance derived from them (see the rules at the top of this file). */
export class LegatoTracker {
  private notes: TrackedNote[] = [];
  private anon = 0;

  /** Notes currently tracked (diagnostics and tests). */
  get size(): number {
    return this.notes.length;
  }

  /**
   * A note-on. `now` is the earliest time that can still change: a late note starts then.
   * A re-used id ends the older note (at `now` at the latest) and keeps it under a private id.
   */
  noteOn(id: number, key: number, velocity: number, time: number, now: number): void {
    const old = this.find(id);
    if (old) {
      if (old.start >= now) this.notes.splice(this.notes.indexOf(old), 1);
      else {
        old.end = Math.min(old.end, now);
        old.id = -++this.anon;
      }
    }
    const start = Number.isFinite(time) ? Math.max(time, now) : now;
    this.notes.push({ id, key, velocity, start, end: Infinity });
  }

  /**
   * A note-off. One at or before its note-on cancels the note (if it hasn't started by `now`;
   * otherwise it is too late to cancel and the note is released at `now`). The earliest note-off
   * wins. Returns false when nothing changed.
   */
  noteOff(id: number, time: number, now: number): boolean {
    const n = this.find(id);
    if (!n) return false;
    let t = Number.isFinite(time) ? time : now;
    if (t <= n.start) {
      if (n.start >= now) {
        this.notes.splice(this.notes.indexOf(n), 1);
        return true;
      }
      t = now;
    }
    const end = Math.max(t, now);
    if (end >= n.end) return false;
    n.end = end;
    return true;
  }

  /** Releases every note sounding at `time` and drops every note starting at or after it. */
  allNotesOff(time: number, now: number): boolean {
    const t = Number.isFinite(time) ? Math.max(time, now) : now;
    let changed = false;
    this.notes = this.notes.filter((n) => {
      if (n.start >= t) {
        changed = true;
        return false;
      }
      if (n.end > t) {
        n.end = t;
        changed = true;
      }
      return true;
    });
    return changed;
  }

  /** Forgets notes (a finished phrase). */
  forget(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.notes = this.notes.filter((n) => !drop.has(n.id));
  }

  clear(): void {
    this.notes = [];
  }

  /** The mono performance of every tracked note, phrase by phrase, in time order. */
  phrases(): Phrase[] {
    const sorted = [...this.notes].sort((a, b) => a.start - b.start || a.key - b.key || a.id - b.id);
    const builder = new PhraseBuilder();
    for (const note of sorted) builder.add(note);
    return builder.finish();
  }

  private find(id: number): TrackedNote | undefined {
    return this.notes.find((n) => n.id === id);
  }
}
