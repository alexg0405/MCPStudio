import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@core/model/defaults';
import type { Project } from '@core/model/types';
import { CHORD_ABOVE, FIXED, GUIDE, initialRows, rowsOfSet, ruleOfRow, specOfRows, STARTING_SETS, warningsFor } from './dialog-model';

const project = (patch: (p: Project) => void = () => {}): Project => {
  const p = createEmptyProject();
  patch(p);
  return p;
};

describe('the harmony dialog rows', () => {
  it('start as a third above and a third below, spread to the sides', () => {
    const rows = initialRows();
    expect(rows.map((r) => r.choice)).toEqual(['third_above', 'third_below']);
    expect(rows[0]!.pan).toBeLessThan(0);
    expect(rows[1]!.pan).toBeGreaterThan(0);
  });

  it('turn into rules: named intervals, chord tones, a fixed interval and a guide melody', () => {
    const base = initialRows()[0]!;
    expect(ruleOfRow({ ...base, choice: 'fifth_below' }, [])).toEqual({ kind: 'interval', steps: -4 });
    expect(ruleOfRow({ ...base, choice: CHORD_ABOVE }, [])).toEqual({ kind: 'chord', side: 'above' });
    expect(ruleOfRow({ ...base, choice: FIXED, semitones: 40 }, [])).toEqual({ kind: 'semitones', semitones: 12 });
    expect(ruleOfRow({ ...base, choice: GUIDE }, [])).toBeNull();
    expect(ruleOfRow({ ...base, choice: GUIDE }, [{ tick: 0, length: 960, pitch: 60 }])).toMatchObject({ kind: 'midi' });
  });

  it('refuse a guide voice with no channel chosen, in plain words', () => {
    const rows = [{ ...initialRows()[0]!, choice: GUIDE }];
    const result = specOfRows(project(), rows, { timingMs: 10, driftCents: 5, vibrato: 0.2 }, 1);
    expect('problem' in result && result.problem).toMatch(/guide melody/);
  });

  it('warn about a missing key and an empty chord track, and not when they are there', () => {
    const rows = rowsOfSet(STARTING_SETS[1]!);
    const bare = warningsFor(project(), [...rows, ...initialRows()]);
    expect(bare).toHaveLength(2);
    expect(bare[0]).toMatch(/no key/);
    expect(bare[1]).toMatch(/chord track is empty/);
    const ready = project((p) => {
      p.transport.key = { root: 9, scale: 'minor' };
      p.chords = { c1: { id: 'c1', tick: 0, length: 3840, root: 9, quality: 'min' } } as unknown as Project['chords'];
    });
    expect(warningsFor(ready, [...rows, ...initialRows()])).toEqual([]);
  });

  it('give each starting set its voices with a level and pan for that many', () => {
    const choir = rowsOfSet(STARTING_SETS[2]!);
    expect(choir).toHaveLength(4);
    expect(new Set(choir.map((r) => r.pan)).size).toBe(4);
    expect(choir.every((r) => r.levelDb === -9)).toBe(true);
  });
});
