import { describe, expect, it } from 'vitest';
import { produce, produceWithPatches, enablePatches } from 'immer';
import type { NoteId } from '../model/types';
import { editNotes, sanitizeNote, setSongKey, writeNotes } from './notes';
import { applyNoteReplacement, planNoteReplacement } from './note-replace';
import { note, notesIn, withNotes } from '../../../test/helpers/notes';

enablePatches();

describe('note fields (pan, mute, release, fine)', () => {
  it('editNotes sets, clamps and clears the optional fields', () => {
    const { p, pid, cid } = withNotes([note('a', 0), note('b', 240, 62, 240, { pan: 0.5, fine: 20 })]);
    const next = produce(p, (d) =>
      editNotes(d, pid, cid, [
        { id: 'a' as NoteId, pan: -3, muted: true, release: 0.9, fine: 250 },
        { id: 'b' as NoteId, pan: 0, fine: 0, muted: false, release: 0.5 },
      ]),
    );
    const [a, b] = notesIn(next, pid, cid);
    expect(a).toMatchObject({ pan: -1, muted: true, release: 0.9, fine: 100 });
    // Neutral values remove the fields.
    expect(b).toEqual(note('b', 240, 62));
    // Leaving a field out keeps it.
    const kept = produce(next, (d) => editNotes(d, pid, cid, [{ id: 'a' as NoteId, velocity: 0.3 }]));
    expect(notesIn(kept, pid, cid)[0]).toMatchObject({ pan: -1, muted: true, velocity: 0.3 });
  });

  it('resetting a clean note to neutral values changes nothing', () => {
    const { p, pid, cid } = withNotes([note('a', 0)]);
    const [, patches] = produceWithPatches(p, (d) =>
      editNotes(d, pid, cid, [{ id: 'a' as NoteId, pan: 0, muted: false, release: 0.5, fine: 0 }]),
    );
    expect(patches).toEqual([]);
  });

  it('sanitizeNote clamps optional fields that are present', () => {
    expect(sanitizeNote({ ...note('a', -5, 200), pan: 2, release: -1, fine: Number.NaN })).toEqual({
      ...note('a', 0, 127),
      pan: 1,
      release: 0,
      fine: 0,
    });
  });

  it('writeNotes writes notes exactly and skips unchanged ones', () => {
    const { p, pid, cid } = withNotes([note('a', 0, 60, 240, { pan: 0.4 }), note('b', 240)]);
    const next = produce(p, (d) =>
      writeNotes(d, pid, cid, [note('a', 480, 64), note('b', 240), note('c', 960, 67, 100, { muted: true })]),
    );
    const notes = notesIn(next, pid, cid);
    expect(notes.map((n) => n.id)).toEqual(['b', 'a', 'c']);
    // 'a' lost its pan: the written note had none.
    expect(notes[1]).toEqual(note('a', 480, 64));
    expect(next.patterns[pid]!.notes[cid]!['b' as NoteId]).toBe(p.patterns[pid]!.notes[cid]!['b' as NoteId]);
    const [, patches] = produceWithPatches(next, (d) => writeNotes(d, pid, cid, notes));
    expect(patches).toEqual([]);
  });

  it('sets and clears the song key', () => {
    const { p } = withNotes();
    const keyed = produce(p, (d) => setSongKey(d, { root: 14, scale: 'minor' }));
    expect(keyed.transport.key).toEqual({ root: 2, scale: 'minor' });
    expect(produce(keyed, (d) => setSongKey(d, { root: 2, scale: 'minor' }))).toBe(keyed);
    expect(produce(keyed, (d) => setSongKey(d, { root: 0, scale: ' ' }))).toBe(keyed);
    expect(produce(keyed, (d) => setSongKey(d, null)).transport.key).toBeUndefined();
  });
});

describe('note replacement', () => {
  const inputs = [note('a', 0, 60, 240, { pan: 0.3 }), note('b', 240, 62), note('c', 480, 64)];
  const mint = (i: number) => `new${i}` as NoteId;

  it('edits notes that keep their id, adds new ones and removes the rest', () => {
    const plan = planNoteReplacement(
      inputs,
      [
        { id: 'a', tick: 10, length: 100, key: 61, velocity: 0.5 },
        { tick: 960, length: 240, key: 70, velocity: 2 },
        { id: 'c', tick: 480, length: 240, key: 64, velocity: 0.8, pan: 0 },
        // A repeated or unknown id is a new note.
        { id: 'a', tick: 20, length: 1, key: 1, velocity: 0.1 },
        { id: 'zzz', tick: 30, length: 1, key: 2, velocity: 0.1 },
      ],
      mint,
    );
    expect(plan.remove).toEqual(['b']);
    expect(plan.added).toBe(3);
    expect(plan.write.map((n) => n.id)).toEqual(['a', 'new0', 'c', 'new1', 'new2']);
    // Fields the output leaves out keep the input's value; velocity is clamped.
    expect(plan.write[0]).toEqual({ id: 'a', tick: 10, length: 100, key: 61, velocity: 0.5, pan: 0.3 });
    expect(plan.write[1]?.velocity).toBe(1);
    expect(plan.write[2]).toEqual(note('c', 480, 64));
  });

  it('applies as an absolute recipe: a second preview lands on the same document', () => {
    const { p, pid, cid } = withNotes(inputs);
    const first = planNoteReplacement(
      inputs,
      [
        { tick: 0, length: 120, key: 72, velocity: 1 },
        { tick: 120, length: 120, key: 74, velocity: 1 },
      ],
      mint,
    );
    const second = planNoteReplacement(inputs, [{ id: 'b', tick: 0, length: 960, key: 50, velocity: 1 }], mint);
    const previewed = produce(p, (d) => applyNoteReplacement(d, pid, cid, first));
    const stale = first.write.filter((n) => !second.write.some((w) => w.id === n.id)).map((n) => n.id);
    const twice = produce(previewed, (d) => applyNoteReplacement(d, pid, cid, second, stale));
    const once = produce(p, (d) => applyNoteReplacement(d, pid, cid, second));
    expect(notesIn(twice, pid, cid)).toEqual(notesIn(once, pid, cid));
    expect(notesIn(once, pid, cid)).toEqual([note('b', 0, 50, 960, { velocity: 1 })]);
  });
});
