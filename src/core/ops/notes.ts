import { isDraft, original, type Draft } from 'immer';
import { newId } from '../model/ids';
import type { ChannelId, Note, NoteId, PatternId, Project, SongKey, Tick } from '../model/types';
import { TICKS_PER_STEP } from '../time/ppq';

// Draft mutators for notes and patterns.

function notesOf(d: Draft<Project>, patternId: PatternId, channelId: ChannelId, create: boolean) {
  const pattern = d.patterns[patternId];
  if (!pattern) return undefined;
  let notes = pattern.notes[channelId];
  if (!notes && create) {
    notes = {};
    pattern.notes[channelId] = notes;
  }
  return notes;
}

export function addNote(d: Draft<Project>, patternId: PatternId, channelId: ChannelId, note: Note): void {
  const notes = notesOf(d, patternId, channelId, true);
  if (notes) notes[note.id] = sanitizeNote(note);
}

export function removeNote(d: Draft<Project>, patternId: PatternId, channelId: ChannelId, noteId: NoteId): void {
  const pattern = d.patterns[patternId];
  const notes = pattern?.notes[channelId];
  if (!pattern || !notes || !notes[noteId]) return;
  delete notes[noteId];
  if (Object.keys(notes).length === 0) delete pattern.notes[channelId];
}

export function updateNote(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  noteId: NoteId,
  patch: Partial<Omit<Note, 'id'>>,
): void {
  const note = notesOf(d, patternId, channelId, false)?.[noteId];
  if (!note) return;
  Object.assign(note, sanitizeNote({ ...note, ...patch }));
}

/**
 * The step-sequencer note at `step`, if any: the note starting on that step at the root key, or else
 * a note there that is at most one step long (steps can have their own key, FL's graph editor).
 */
export function findStepNote(
  notes: Readonly<Record<NoteId, Note>> | undefined,
  step: number,
  rootKey: number,
): Note | undefined {
  if (!notes) return undefined;
  const tick = step * TICKS_PER_STEP;
  let other: Note | undefined;
  for (const id in notes) {
    const n = notes[id as NoteId];
    if (!n || n.tick !== tick) continue;
    if (n.key === rootKey) return n;
    if (!other && n.length <= TICKS_PER_STEP) other = n;
  }
  return other;
}

/**
 * Turns a step on or off. Off removes any root-key note starting on that step. On adds a 1-step
 * note (FL's default step length) unless one is already there.
 */
export function setStep(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  step: number,
  on: boolean,
  opts: { rootKey: number; velocity?: number; id?: NoteId },
): void {
  const pattern = d.patterns[patternId];
  if (!pattern || step < 0) return;
  const existing = findStepNote(pattern.notes[channelId] as Record<NoteId, Note> | undefined, step, opts.rootKey);
  if (on) {
    if (existing) return;
    addNote(d, patternId, channelId, {
      id: opts.id ?? newId.note(),
      tick: step * TICKS_PER_STEP,
      length: TICKS_PER_STEP,
      key: opts.rootKey,
      velocity: opts.velocity ?? 100 / 128,
    });
    if (step >= pattern.stepCount) pattern.stepCount = Math.ceil((step + 1) / 16) * 16;
  } else if (existing) {
    removeNote(d, patternId, channelId, existing.id);
  }
}

export function setStepCount(d: Draft<Project>, patternId: PatternId, steps: number): void {
  const pattern = d.patterns[patternId];
  if (pattern) pattern.stepCount = Math.max(1, Math.min(512, Math.round(steps)));
}

export function renamePattern(d: Draft<Project>, patternId: PatternId, name: string): void {
  const pattern = d.patterns[patternId];
  if (pattern && name.trim()) pattern.name = name.trim().slice(0, 64);
}

export function setBpm(d: Draft<Project>, bpm: number): void {
  if (Number.isFinite(bpm)) d.transport.bpm = Math.round(Math.min(522, Math.max(10, bpm)) * 1000) / 1000;
}

export function setSwing(d: Draft<Project>, swing: number): void {
  if (Number.isFinite(swing)) d.transport.swing = Math.min(1, Math.max(0, swing));
}

/** Sets the song key (scale highlighting, snapping, note scripts), or clears it with null. */
export function setSongKey(d: Draft<Project>, key: SongKey | null): void {
  if (!key) {
    if (d.transport.key) delete d.transport.key;
    return;
  }
  const scale = typeof key.scale === 'string' ? key.scale.trim().slice(0, 64) : '';
  if (!Number.isFinite(key.root) || !scale) return;
  const root = ((Math.round(key.root) % 12) + 12) % 12;
  const cur = d.transport.key;
  if (cur?.root === root && cur.scale === scale) return;
  d.transport.key = { root, scale };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Rounds and clamps a note into the model's ranges (the optional fields only when present). */
export function sanitizeNote(n: Note): Note {
  const tick: Tick = Math.max(0, Math.round(n.tick));
  const out: Note = {
    ...n,
    tick,
    length: Math.max(1, Math.round(n.length)),
    key: clamp(Math.round(n.key), 0, 127),
    velocity: clamp(n.velocity, 0, 1),
  };
  if (out.pan !== undefined) out.pan = Number.isFinite(out.pan) ? clamp(out.pan, -1, 1) : 0;
  if (out.release !== undefined) out.release = Number.isFinite(out.release) ? clamp(out.release, 0, 1) : 0.5;
  if (out.fine !== undefined) out.fine = Number.isFinite(out.fine) ? clamp(out.fine, -100, 100) : 0;
  if (out.muted !== undefined && typeof out.muted !== 'boolean') delete out.muted;
  return out;
}

/**
 * The values a note has when an optional field is absent. Edits that set a field to its neutral
 * value remove the field, so documents stay minimal and "reset" edits are no-ops on clean notes.
 */
export const NOTE_NEUTRAL = { pan: 0, muted: false, release: 0.5, fine: 0 } as const;

/** Drops optional fields that hold their neutral value. */
export function compactNote(n: Note): Note {
  const out = { ...n };
  if (out.pan === NOTE_NEUTRAL.pan) delete out.pan;
  if (out.muted === NOTE_NEUTRAL.muted) delete out.muted;
  if (out.release === NOTE_NEUTRAL.release) delete out.release;
  if (out.fine === NOTE_NEUTRAL.fine) delete out.fine;
  return out;
}

/** Two notes are identical in every field. */
export function sameNote(a: Note, b: Note): boolean {
  return (
    a.id === b.id &&
    a.tick === b.tick &&
    a.length === b.length &&
    a.key === b.key &&
    a.velocity === b.velocity &&
    a.pan === b.pan &&
    a.muted === b.muted &&
    a.release === b.release &&
    a.fine === b.fine
  );
}

// ---- Multi-note edits (piano roll) ----

export interface NoteEdit {
  id: NoteId;
  tick?: Tick;
  length?: Tick;
  key?: number;
  velocity?: number;
  /** −1…1 (0, centred, removes the field). */
  pan?: number;
  /** false removes the field. */
  muted?: boolean;
  /** Release velocity 0–1 (0.5, the default, removes the field). */
  release?: number;
  /** Fine pitch in cents, −100…100 (0 removes the field). */
  fine?: number;
}

type OptionalField = keyof typeof NOTE_NEUTRAL;

/** Sets an optional field on a draft note, removing it when it is absent or neutral. */
function setOptional<K extends OptionalField>(n: Draft<Note>, field: K, value: Note[K]): void {
  if (value === undefined || value === NOTE_NEUTRAL[field]) {
    if (n[field] !== undefined) delete n[field];
  } else if (n[field] !== value) (n as Note)[field] = value;
}

/** Applies absolute edits to existing notes (missing ids are ignored). */
export function editNotes(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  edits: readonly NoteEdit[],
): void {
  const notes = d.patterns[patternId]?.notes[channelId];
  if (!notes) return;
  for (const e of edits) {
    const n = notes[e.id];
    if (!n) continue;
    const next = sanitizeNote({
      ...n,
      ...(e.tick !== undefined ? { tick: e.tick } : {}),
      ...(e.length !== undefined ? { length: e.length } : {}),
      ...(e.key !== undefined ? { key: e.key } : {}),
      ...(e.velocity !== undefined ? { velocity: e.velocity } : {}),
      ...(e.pan !== undefined ? { pan: e.pan } : {}),
      ...(e.muted !== undefined ? { muted: e.muted } : {}),
      ...(e.release !== undefined ? { release: e.release } : {}),
      ...(e.fine !== undefined ? { fine: e.fine } : {}),
    });
    if (next.tick !== n.tick) n.tick = next.tick;
    if (next.length !== n.length) n.length = next.length;
    if (next.key !== n.key) n.key = next.key;
    if (next.velocity !== n.velocity) n.velocity = next.velocity;
    if (e.pan !== undefined) setOptional(n, 'pan', next.pan);
    if (e.muted !== undefined) setOptional(n, 'muted', next.muted);
    if (e.release !== undefined) setOptional(n, 'release', next.release);
    if (e.fine !== undefined) setOptional(n, 'fine', next.fine);
  }
}

/**
 * Writes notes exactly as given: adds missing ones and overwrites existing ones field by field
 * (optional fields the given note leaves out, or sets to their neutral value, are removed). Notes
 * equal to their state before the recipe started are skipped without touching the draft, so
 * rewriting 10k unchanged notes allocates no proxies (callers must not rely on rewriting a note
 * that the same recipe already changed back to its original value).
 */
export function writeNotes(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  notes: readonly Note[],
): void {
  const map = notesOf(d, patternId, channelId, true);
  if (!map) return;
  const base = (isDraft(map) ? original(map) : undefined) as Readonly<Record<NoteId, Note>> | undefined;
  for (const raw of notes) {
    const n = compactNote(sanitizeNote(raw));
    const before = base?.[n.id];
    // `in` reads the draft without creating a proxy for the note.
    if (before && sameNote(before, n) && n.id in map) continue;
    const cur = map[n.id];
    if (!cur) {
      map[n.id] = n;
      continue;
    }
    if (cur.tick !== n.tick) cur.tick = n.tick;
    if (cur.length !== n.length) cur.length = n.length;
    if (cur.key !== n.key) cur.key = n.key;
    if (cur.velocity !== n.velocity) cur.velocity = n.velocity;
    setOptional(cur, 'pan', n.pan);
    setOptional(cur, 'muted', n.muted);
    setOptional(cur, 'release', n.release);
    setOptional(cur, 'fine', n.fine);
  }
}

export function addNotes(d: Draft<Project>, patternId: PatternId, channelId: ChannelId, notes: readonly Note[]): void {
  for (const n of notes) addNote(d, patternId, channelId, n);
}

export function removeNotes(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  ids: readonly NoteId[],
): void {
  for (const id of ids) removeNote(d, patternId, channelId, id);
}

/** Splits a note at `at` (pattern ticks) into two notes; returns nothing if `at` is outside the note. */
export function sliceNote(
  d: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  noteId: NoteId,
  at: Tick,
  secondId: NoteId = newId.note(),
): void {
  const n = d.patterns[patternId]?.notes[channelId]?.[noteId];
  if (!n || at <= n.tick || at >= n.tick + n.length) return;
  const end = n.tick + n.length;
  n.length = at - n.tick;
  addNote(d, patternId, channelId, { ...n, id: secondId, tick: at, length: end - at });
}
