import type { Draft } from 'immer';
import { newId } from '../model/ids';
import type { ChannelId, Note, NoteId, PatternId, Project, Tick } from '../model/types';
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

/** The step-sequencer note at `step`, if any (a note on the step boundary at the root key, ≤ 1 step long). */
export function findStepNote(
  notes: Readonly<Record<NoteId, Note>> | undefined,
  step: number,
  rootKey: number,
): Note | undefined {
  if (!notes) return undefined;
  const tick = step * TICKS_PER_STEP;
  for (const id in notes) {
    const n = notes[id as NoteId];
    if (n && n.tick === tick && n.key === rootKey) return n;
  }
  return undefined;
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

export function sanitizeNote(n: Note): Note {
  const tick: Tick = Math.max(0, Math.round(n.tick));
  return {
    ...n,
    tick,
    length: Math.max(1, Math.round(n.length)),
    key: Math.max(0, Math.min(127, Math.round(n.key))),
    velocity: Math.max(0, Math.min(1, n.velocity)),
  };
}
