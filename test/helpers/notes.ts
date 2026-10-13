/** Test helpers for note edits (M11): a project with one instrument channel and some notes. */
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { ChannelId, Note, NoteId, PatternId, Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNotes } from '@core/ops/notes';
import { notesSorted } from '@core/query/queries';

/** A note with defaults (one step long, velocity 0.8). */
export function note(id: string, tick: number, key = 60, length = 240, extra: Partial<Note> = {}): Note {
  return { id: id as NoteId, tick, length, key, velocity: 0.8, ...extra };
}

/** A project whose first pattern holds `notes` on one instrument channel. */
export function withNotes(notes: readonly Note[] = []): { p: Project; pid: PatternId; cid: ChannelId } {
  const ch = makeInstrumentChannel('Synth', makePluginInstance('x', 1, {}));
  const base = createEmptyProject();
  const pid = base.patternOrder[0] as PatternId;
  const p = produce(base, (d) => {
    addChannel(d, ch);
    addNotes(d, pid, ch.id, notes);
  });
  return { p, pid, cid: ch.id };
}

/** The channel's notes in time order. */
export function notesIn(p: Project, pid: PatternId, cid: ChannelId): readonly Note[] {
  return notesSorted(p.patterns[pid]?.notes[cid]);
}

/** "tick:key:length" per note in time order, for compact assertions. */
export function layout(notes: readonly Note[]): string[] {
  return notes.map((n) => `${n.tick}:${n.key}:${n.length}`);
}
