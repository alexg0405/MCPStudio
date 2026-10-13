import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '../model/defaults';
import type { ChannelId, Note, NoteId, PatternId, Project } from '../model/types';
import { addChannel } from './channels';
import { addNotes, editNotes, removeNotes, sliceNote } from './notes';
import { noteAt, noteBounds, notesInRect } from '../query/notes-hit';
import { notesSorted } from '../query/queries';

const note = (id: string, tick: number, key: number, length = 240): Note => ({
  id: id as NoteId,
  tick,
  length,
  key,
  velocity: 0.8,
});

function setup(): { p: Project; pid: PatternId; cid: ChannelId } {
  let p = createEmptyProject();
  const ch = makeInstrumentChannel('Synth', makePluginInstance('x', 1, {}));
  const pid = p.patternOrder[0] as PatternId;
  p = produce(p, (d) => {
    addChannel(d, ch);
    addNotes(d, pid, ch.id, [note('a', 0, 60), note('b', 480, 64, 960), note('c', 960, 67)]);
  });
  return { p, pid, cid: ch.id };
}

describe('multi-note ops', () => {
  it('edits several notes absolutely and sanitizes values', () => {
    const { p, pid, cid } = setup();
    const next = produce(p, (d) =>
      editNotes(d, pid, cid, [
        { id: 'a' as NoteId, tick: 120, key: 200 },
        { id: 'b' as NoteId, length: 0, velocity: 2 },
        { id: 'zzz' as NoteId, tick: 5 },
      ]),
    );
    const notes = next.patterns[pid]!.notes[cid]!;
    expect(notes['a' as NoteId]).toMatchObject({ tick: 120, key: 127 });
    expect(notes['b' as NoteId]).toMatchObject({ length: 1, velocity: 1 });
  });

  it('removes notes and drops the channel map when empty', () => {
    const { p, pid, cid } = setup();
    const next = produce(p, (d) => removeNotes(d, pid, cid, ['a', 'b', 'c'] as NoteId[]));
    expect(next.patterns[pid]!.notes[cid]).toBeUndefined();
  });

  it('slices a note in two', () => {
    const { p, pid, cid } = setup();
    const next = produce(p, (d) => sliceNote(d, pid, cid, 'b' as NoteId, 720, 'b2' as NoteId));
    const notes = next.patterns[pid]!.notes[cid]!;
    expect(notes['b' as NoteId]).toMatchObject({ tick: 480, length: 240 });
    expect(notes['b2' as NoteId]).toMatchObject({ tick: 720, length: 720, key: 64 });
    // Slicing outside the note does nothing.
    expect(produce(p, (d) => sliceNote(d, pid, cid, 'a' as NoteId, 500))).toBe(p);
  });
});

describe('note hit-testing', () => {
  const { p, pid, cid } = setup();
  const sorted = notesSorted(p.patterns[pid]!.notes[cid]);

  it('finds the note under a point, including long notes started earlier', () => {
    expect(noteAt(sorted, 100, 60)?.id).toBe('a');
    expect(noteAt(sorted, 1300, 64)?.id).toBe('b');
    expect(noteAt(sorted, 1300, 65)).toBeUndefined();
    expect(noteAt(sorted, 240, 60)).toBeUndefined(); // end is exclusive
  });

  it('selects notes intersecting a rectangle', () => {
    expect(notesInRect(sorted, 400, 1000, 62, 70).sort()).toEqual(['b', 'c']);
    expect(notesInRect(sorted, 0, 10, 50, 59)).toEqual([]);
  });

  it('computes bounds', () => {
    expect(noteBounds(sorted)).toEqual({ start: 0, end: 1440, low: 60, high: 67 });
    expect(noteBounds([])).toBeNull();
  });
});
