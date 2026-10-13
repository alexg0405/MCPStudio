import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import type { Note, NoteId, Project, PatternId, ChannelId } from '../model/types';
import { stepView } from '../query/queries';
import { addNote, editNotes, findStepNote, setStep } from './notes';
import { clearSteps, fillSteps, randomizeSteps, reverseSteps, rotateSteps, shiftSteps } from './steps';
import { note, notesIn, withNotes } from '../../../test/helpers/notes';

/** The step row as a string: 1 = on. */
function row(p: Project, pid: PatternId, cid: ChannelId): string {
  const view = stepView(p.patterns[pid]!.notes[cid], p.patterns[pid]!.stepCount);
  expect(view.isSteps).toBe(true);
  return view.velocities.map((v) => (v > 0 ? 1 : 0)).join('');
}

const steps = (...on: number[]): Note[] => on.map((s) => note(`s${s}`, s * 240));

describe('step sequencer ops', () => {
  it('fills every N steps, replacing what was there', () => {
    const { p, pid, cid } = withNotes([note('long', 0, 64, 2000)]);
    for (const [every, expected] of [
      [2, '1010101010101010'],
      [4, '1000100010001000'],
      [8, '1000000010000000'],
    ] as const) {
      const next = produce(p, (d) => fillSteps(d, pid, cid, every, { rootKey: 60 }));
      expect(row(next, pid, cid)).toBe(expected);
      expect(notesIn(next, pid, cid).every((n) => n.key === 60 && n.length === 240)).toBe(true);
    }
  });

  it('rotates with wrap-around and shifts without it', () => {
    const { p, pid, cid } = withNotes(steps(0, 1, 15));
    expect(
      row(
        produce(p, (d) => rotateSteps(d, pid, cid, 1)),
        pid,
        cid,
      ),
    ).toBe('1110000000000000');
    expect(
      row(
        produce(p, (d) => rotateSteps(d, pid, cid, -1)),
        pid,
        cid,
      ),
    ).toBe('1000000000000011');
    expect(
      row(
        produce(p, (d) => shiftSteps(d, pid, cid, 1)),
        pid,
        cid,
      ),
    ).toBe('0110000000000000');
    expect(
      row(
        produce(p, (d) => shiftSteps(d, pid, cid, -1)),
        pid,
        cid,
      ),
    ).toBe('1000000000000010');
    // Rotating by the whole grid is the identity.
    expect(
      notesIn(
        produce(p, (d) => rotateSteps(d, pid, cid, 16)),
        pid,
        cid,
      ),
    ).toEqual(notesIn(p, pid, cid));
  });

  it('reverses steps (and mirrors other notes in time)', () => {
    const { p, pid, cid } = withNotes(steps(0, 1, 5));
    const rev = produce(p, (d) => reverseSteps(d, pid, cid));
    expect(row(rev, pid, cid)).toBe('0000000000100011');
    expect(
      notesIn(
        produce(rev, (d) => reverseSteps(d, pid, cid)),
        pid,
        cid,
      ),
    ).toEqual(notesIn(p, pid, cid));
    const melody = withNotes([note('a', 0, 60, 960), note('b', 960, 62, 480)]);
    const flipped = produce(melody.p, (d) => reverseSteps(d, melody.pid, melody.cid));
    expect(notesIn(flipped, melody.pid, melody.cid).map((n) => `${n.id}@${n.tick}`)).toEqual(['b@2400', 'a@2880']);
  });

  it('randomizes steps from a seeded source and clears', () => {
    const { p, pid, cid } = withNotes(steps(3));
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const next = produce(p, (d) => randomizeSteps(d, pid, cid, { rootKey: 60, rand, density: 0.5 }));
    const on = row(next, pid, cid);
    expect(on).toMatch(/^[01]{16}$/);
    expect(on.includes('1')).toBe(true);
    for (const n of notesIn(next, pid, cid)) expect(n.velocity).toBeGreaterThanOrEqual(0.55);
    expect(produce(next, (d) => clearSteps(d, pid, cid)).patterns[pid]!.notes[cid]).toBeUndefined();
  });

  it('keeps steps whose key was changed in the graph editor', () => {
    const { p, pid, cid } = withNotes(steps(0, 4));
    const pitched = produce(p, (d) => editNotes(d, pid, cid, [{ id: 's4' as NoteId, key: 67, fine: 30 }]));
    const view = stepView(pitched.patterns[pid]!.notes[cid], 16);
    expect(view.isSteps).toBe(true);
    expect(view.notes[4]).toMatchObject({ key: 67, fine: 30 });
    // Toggling the step off finds the pitched note; on is a no-op while it's there.
    const notes = pitched.patterns[pid]!.notes[cid];
    expect(findStepNote(notes, 4, 60)?.id).toBe('s4');
    expect(produce(pitched, (d) => setStep(d, pid, cid, 4, true, { rootKey: 60 }))).toBe(pitched);
    const off = produce(pitched, (d) => setStep(d, pid, cid, 4, false, { rootKey: 60 }));
    expect(row(off, pid, cid)).toBe('1000000000000000');
    // Two notes on one step make it a piano-roll pattern.
    const chord = produce(pitched, (d) => addNote(d, pid, cid, note('x', 0, 64)));
    expect(stepView(chord.patterns[pid]!.notes[cid], 16).isSteps).toBe(false);
  });
});
