/** The motif's rhythm cells and the changes that turn a statement into a variation. */
import { describe, expect, it } from 'vitest';
import {
  answered,
  inverted,
  makeMotif,
  ornamented,
  shifted,
  syncopated,
  thinned,
  transposed,
  type MotifNote,
} from './motif';
import type { RhythmFamily } from './profiles';
import { makeRng } from './rng';

const FAMILIES: readonly RhythmFamily[] = ['plain', 'bounce', 'laid', 'driving'];

/** The pitch each note reaches, as scale steps from where the motif's first move starts. */
const reached = (motif: readonly MotifNote[]): number[] => {
  let at = 0;
  return motif.map((note) => (at += note.move));
};

describe('making a motif', () => {
  it('makes two bars of notes inside the phrase, in time order, that start on the downbeat of a cell', () => {
    for (const family of FAMILIES) {
      for (let seed = 1; seed <= 20; seed++) {
        for (const kind of ['verse', 'hook'] as const) {
          const motif = makeMotif(kind, family, makeRng(seed));
          expect(motif.length, `${family} ${kind} ${seed}`).toBeGreaterThanOrEqual(3);
          motif.forEach((note, index) => {
            expect(note.step).toBeGreaterThanOrEqual(0);
            expect(note.step).toBeLessThan(32);
            expect(Number.isInteger(note.step)).toBe(true);
            expect(Number.isInteger(note.len)).toBe(true);
            expect(note.len).toBeGreaterThanOrEqual(1);
            if (index > 0) expect(note.step).toBeGreaterThan((motif[index - 1] as MotifNote).step);
          });
        }
      }
    }
  });

  it('makes a hook with fewer notes than a verse line, so it is easy to remember', () => {
    for (const family of FAMILIES) {
      let hook = 0;
      let verse = 0;
      for (let seed = 1; seed <= 30; seed++) {
        hook += makeMotif('hook', family, makeRng(seed)).length;
        verse += makeMotif('verse', family, makeRng(seed)).length;
      }
      expect(hook, family).toBeLessThan(verse);
    }
  });

  it('keeps the first bar’s contour in the second bar when the rhythm repeats (a repeat that answers)', () => {
    let repeats = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const motif = makeMotif('hook', 'plain', makeRng(seed));
      const firstBar = motif.filter((note) => note.step < 16);
      const secondBar = motif.filter((note) => note.step >= 16);
      const sameRhythm =
        firstBar.length === secondBar.length &&
        firstBar.every((note, index) => note.step + 16 === secondBar[index]?.step);
      if (!sameRhythm) continue;
      repeats++;
      const same = firstBar.slice(0, -1).filter((note, index) => note.move === secondBar[index]?.move).length;
      expect(same).toBeGreaterThanOrEqual(firstBar.length - 2);
    }
    expect(repeats).toBeGreaterThan(5);
  });
});

describe('changing a motif', () => {
  const motif: MotifNote[] = [
    { step: 0, len: 4, move: 0 },
    { step: 4, len: 2, move: 2 },
    { step: 8, len: 4, move: -1 },
    { step: 16, len: 6, move: 1 },
    { step: 24, len: 3, move: -2 },
  ];

  it('moves a motif later, turns it over and carries it up or down without touching its rhythm', () => {
    expect(shifted(motif, 32).map((note) => note.step)).toEqual([32, 36, 40, 48, 56]);
    expect(inverted(motif).map((note) => note.move)).toEqual([0, -2, 1, -1, 2]);
    expect(transposed(motif, 3).map((note) => note.move)).toEqual([3, 2, -1, 1, -2]);
    expect(transposed(motif, 3).map((note) => note.step)).toEqual(motif.map((note) => note.step));
  });

  it('does not change the original when it makes a variation', () => {
    const before = JSON.stringify(motif);
    const random = makeRng(3);
    inverted(motif);
    transposed(motif, 2);
    thinned(motif);
    ornamented(motif, random);
    syncopated(motif, random);
    answered(motif, random);
    expect(JSON.stringify(motif)).toBe(before);
  });

  it('thins a motif to fewer notes that still end where the line ended', () => {
    const thin = thinned(motif);
    expect(thin.length).toBeLessThan(motif.length);
    // The last note it keeps reaches the same pitch as the last note the motif had.
    expect(reached(thin).at(-1)).toBe(reached(motif).at(-1));
  });

  it('ornaments a motif with extra notes that return to the old line', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const busy = ornamented(motif, makeRng(seed));
      expect(busy.length).toBeGreaterThanOrEqual(motif.length);
      expect(reached(busy).at(-1)).toBe(reached(motif).at(-1));
      busy.forEach((note, index) => {
        if (index > 0) expect(note.step).toBeGreaterThan((busy[index - 1] as MotifNote).step);
      });
    }
  });

  it('syncopates by moving one note and keeping the order and the pitches', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const moved = syncopated(motif, makeRng(seed));
      expect(moved).toHaveLength(motif.length);
      expect(moved.map((note) => note.move)).toEqual(motif.map((note) => note.move));
      expect(moved.filter((note, index) => note.step !== (motif[index] as MotifNote).step).length).toBeLessThanOrEqual(
        1,
      );
      expect(moved[0]?.step).toBe(0);
    }
  });

  it('answers by changing the last two moves only', () => {
    const answer = answered(motif, makeRng(5));
    expect(answer.slice(0, 3)).toEqual(motif.slice(0, 3));
    expect(answer.map((note) => note.step)).toEqual(motif.map((note) => note.step));
  });
});
