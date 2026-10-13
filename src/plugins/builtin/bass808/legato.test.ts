import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { firstDifference, LegatoTracker, type LegatoAction, type Phrase } from './legato';

/** Compact form of a performance: "a36@0" attack, "g43@0.25" glide, "r1@0.5" release of note 1. */
function show(phrases: readonly Phrase[]): string[][] {
  return phrases.map((p) =>
    p.actions.map((a) => (a.type === 'release' ? `r${a.id}@${a.time}` : `${a.type[0]}${a.key}@${a.time}`)),
  );
}

const flat = (phrases: readonly Phrase[]): LegatoAction[] => phrases.flatMap((p) => p.actions);

describe('LegatoTracker', () => {
  it('attacks a lone note and releases it at its note-off', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    expect(show(t.phrases())).toEqual([['a36@0']]);
    expect(t.noteOff(1, 0.5, 0)).toBe(true);
    expect(show(t.phrases())).toEqual([['a36@0', 'r1@0.5']]);
  });

  it('glides into a note that starts while the previous one is held and ignores the old note-off', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOn(2, 43, 0.8, 0.25, 0);
    t.noteOff(1, 0.5, 0);
    t.noteOff(2, 0.75, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'g43@0.25', 'r2@0.75']]);
    const glide = t.phrases()[0]!.actions[1]!;
    expect(glide).toMatchObject({ type: 'glide', id: 2, velocity: 0.8 });
  });

  it('chains glides while each note overlaps the next', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOn(2, 38, 1, 0.2, 0);
    t.noteOn(3, 31, 1, 0.4, 0);
    t.noteOff(1, 0.3, 0);
    t.noteOff(2, 0.5, 0);
    t.noteOff(3, 0.9, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'g38@0.2', 'g31@0.4', 'r3@0.9']]);
  });

  it('retriggers touching notes even when the note-off arrives after the next note-on', () => {
    // The scheduler sends a window's note-ons before its note-offs.
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOn(2, 36, 1, 0.25, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'g36@0.25']]);
    t.noteOff(1, 0.25, 0);
    t.noteOff(2, 0.5, 0);
    expect(show(t.phrases())).toEqual([
      ['a36@0', 'r1@0.25'],
      ['a36@0.25', 'r2@0.5'],
    ]);
  });

  it('turns a glide back into a retrigger when the earlier note turns out to have ended first', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOn(2, 43, 1, 0.3, 0);
    t.noteOff(1, 0.2, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'r1@0.2'], ['a43@0.3']]);
  });

  it('glides from a note whose note-on arrives late (swing, several clips)', () => {
    const t = new LegatoTracker();
    t.noteOn(2, 43, 1, 0.3, 0);
    t.noteOn(1, 36, 1, 0, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'g43@0.3']]);
  });

  it('cancels a note whose note-off is at or before its note-on', () => {
    for (const off of [0.25, 0.1]) {
      const t = new LegatoTracker();
      t.noteOn(1, 36, 1, 0.25, 0);
      expect(t.noteOff(1, off, 0)).toBe(true);
      expect(t.phrases()).toEqual([]);
      expect(t.size).toBe(0);
    }
  });

  it('cancelling a glide target restores the note it would have slid from', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOn(2, 43, 1, 0.25, 0);
    t.noteOff(1, 0.5, 0);
    t.noteOff(2, 0.75, 0);
    // A live edit deletes note 2 before it plays: its note-off at its own start cancels it.
    t.noteOff(2, 0.25, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'r1@0.5']]);
  });

  it('releases instead of cancelling a note that has already started', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0.1, 0);
    expect(t.noteOff(1, 0.1, 0.3)).toBe(true);
    expect(show(t.phrases())).toEqual([['a36@0.1', 'r1@0.3']]);
  });

  it('clamps late events to now', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0.1, 0.2);
    t.noteOff(1, 0.15, 0.25);
    expect(show(t.phrases())).toEqual([['a36@0.2', 'r1@0.25']]);
  });

  it('keeps the earliest note-off', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    expect(t.noteOff(1, 0.5, 0)).toBe(true);
    expect(t.noteOff(1, 0.7, 0)).toBe(false);
    expect(t.noteOff(1, 0.4, 0)).toBe(true);
    expect(show(t.phrases())).toEqual([['a36@0', 'r1@0.4']]);
  });

  it('plays the lowest of simultaneous notes, and the next one if that is cancelled', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 43, 1, 0, 0);
    t.noteOn(2, 36, 1, 0, 0);
    t.noteOff(1, 0.5, 0);
    t.noteOff(2, 0.3, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'r2@0.3']]);
    expect(t.phrases()[0]!.ids).toEqual([2, 1]);
    t.noteOff(2, 0, 0);
    expect(show(t.phrases())).toEqual([['a43@0', 'r1@0.5']]);
  });

  it('all notes off releases what is sounding and drops what is still to come', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOn(2, 43, 1, 0.6, 0);
    expect(t.allNotesOff(0.4, 0)).toBe(true);
    expect(show(t.phrases())).toEqual([['a36@0', 'r1@0.4']]);
    expect(t.allNotesOff(0.4, 0)).toBe(false);
  });

  it('a re-used id ends the older note', () => {
    const t = new LegatoTracker();
    t.noteOn(7, 36, 1, 0, 0);
    t.noteOn(7, 43, 1, 0.5, 0.3);
    t.noteOff(7, 0.8, 0.3);
    expect(show(t.phrases())).toEqual([
      ['a36@0', 'r-1@0.3'],
      ['a43@0.5', 'r7@0.8'],
    ]);
  });

  it('forgets a finished phrase without changing the next ones', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOff(1, 0.2, 0);
    t.noteOn(2, 43, 1, 0.5, 0);
    t.noteOn(3, 45, 1, 0.6, 0);
    const [first, second] = t.phrases();
    t.forget(first!.ids);
    expect(t.phrases()).toEqual([second]);
  });

  it('keeps the action list time-ordered when a release touches the next attack within the tolerance', () => {
    const t = new LegatoTracker();
    t.noteOn(1, 36, 1, 0, 0);
    t.noteOff(1, 0.5 + 1e-7, 0);
    t.noteOn(2, 36, 1, 0.5, 0);
    expect(show(t.phrases())).toEqual([['a36@0', 'r1@0.5'], ['a36@0.5']]);
  });
});

describe('firstDifference', () => {
  it('finds the earliest time two performances differ', () => {
    const a = new LegatoTracker();
    a.noteOn(1, 36, 1, 0, 0);
    a.noteOn(2, 43, 1, 0.3, 0);
    const before = flat(a.phrases());
    expect(firstDifference(before, flat(a.phrases()))).toBe(Infinity);
    a.noteOff(1, 0.2, 0);
    expect(firstDifference(before, flat(a.phrases()))).toBe(0.2);
    expect(firstDifference([], before)).toBe(0);
  });
});

describe('arrival order', () => {
  interface Spec {
    tick: number;
    len: number;
    key: number;
    vel: number;
    cancel: boolean;
  }
  type Ev = { kind: 'on' | 'off'; id: number; time: number; key: number; vel: number; order: number };
  const note = fc.record({
    tick: fc.nat(48),
    len: fc.integer({ min: 1, max: 24 }),
    key: fc.integer({ min: 24, max: 30 }),
    vel: fc.constantFrom(0.5, 1),
    cancel: fc.boolean(),
  });

  function events(specs: Spec[], order: number[]): Ev[] {
    const evs: Ev[] = [];
    specs.forEach((s, i) => {
      const start = s.tick * 0.01;
      const on = { kind: 'on' as const, id: i + 1, time: start, key: s.key, vel: s.vel, order: order[3 * i] ?? 0 };
      // A note-off always arrives after its note-on (the scheduler guarantees that much).
      const after = (o: number | undefined) => Math.max(o ?? 0, on.order) + 1e-9;
      evs.push(on, { ...on, kind: 'off', time: (s.tick + s.len) * 0.01, order: after(order[3 * i + 1]) });
      if (s.cancel) evs.push({ ...on, kind: 'off', time: start, order: after(order[3 * i + 2]) });
    });
    return evs;
  }

  function play(evs: Ev[]): Phrase[] {
    const t = new LegatoTracker();
    for (const e of evs) {
      if (e.kind === 'on') t.noteOn(e.id, e.key, e.vel, e.time, 0);
      else t.noteOff(e.id, e.time, 0);
    }
    return t.phrases();
  }

  it('does not change the performance', () => {
    fc.assert(
      fc.property(
        fc.array(note, { maxLength: 12 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 36, maxLength: 36 }),
        (specs, order) => {
          const evs = events(specs, order);
          // In time order (note-ons first at equal times) vs. in a random order.
          const sorted = [...evs].sort((a, b) => a.time - b.time || (a.kind === 'on' ? -1 : 1));
          const shuffled = [...evs].sort((a, b) => a.order - b.order);
          expect(play(shuffled)).toEqual(play(sorted));
        },
      ),
    );
  });
});
