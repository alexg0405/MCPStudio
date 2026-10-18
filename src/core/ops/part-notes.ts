import type { Draft } from 'immer';
import { newId } from '../model/ids';
import type { ChannelId, Note, NoteId, PatternId, Project, Tick } from '../model/types';
import { addNotes, editNotes } from './notes';

/** A note to write: pattern ticks, MIDI key, velocity 0–1. */
export interface PartNote {
  tick: Tick;
  length: Tick;
  key: number;
  velocity: number;
}

/** Whether any channel of the pattern has notes. */
function patternHasNotes(pattern: Draft<Project>['patterns'][PatternId]): boolean {
  return Object.values(pattern.notes).some((notes) => Object.keys(notes ?? {}).length > 0);
}

/**
 * Writes a generated part (chords, a bassline) for one channel of a pattern, replacing that channel's notes there. A pattern
 * with its own length grows to hold the part; a blank pattern gets `length` as its own, so the part loops where the chords end.
 * Returns how many notes were written.
 */
export function writePart(
  draft: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  notes: readonly PartNote[],
  length: Tick,
): number {
  const pattern = draft.patterns[patternId];
  if (!pattern) return 0;
  delete pattern.notes[channelId];
  const wasBlank = !patternHasNotes(pattern);
  const fresh: Note[] = notes.map((note) => ({
    id: newId.note(),
    tick: Math.max(0, Math.round(note.tick)),
    length: Math.max(1, Math.round(note.length)),
    key: Math.max(0, Math.min(127, Math.round(note.key))),
    velocity: Math.max(0, Math.min(1, note.velocity)),
  }));
  addNotes(draft, patternId, channelId, fresh);
  if (pattern.length !== undefined && length > pattern.length) pattern.length = length;
  else if (pattern.length === undefined && wasBlank) pattern.length = length;
  return fresh.length;
}

/** Moves notes to new keys (a melody fitted to the chords): one edit per note. */
export function setNoteKeys(
  draft: Draft<Project>,
  patternId: PatternId,
  channelId: ChannelId,
  changes: readonly { id: NoteId; key: number }[],
): void {
  editNotes(
    draft,
    patternId,
    channelId,
    changes.map((change) => ({ id: change.id, key: change.key })),
  );
}
