import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  getScale,
  inScale,
  keyAtStep,
  keyLabel,
  noteName,
  pitchClass,
  scaleDegree,
  scaleMask,
  scaleNotes,
  SCALES,
  scaleStep,
  snapToScale,
  transposeInScale,
} from './scales';

const scaleId = fc.constantFrom(...SCALES.map((s) => s.id));
const root = fc.integer({ min: 0, max: 11 });
const key = fc.integer({ min: 0, max: 127 });

describe('scales', () => {
  it('are well formed: start at 0, ascending, inside an octave, unique ids', () => {
    expect(new Set(SCALES.map((s) => s.id)).size).toBe(SCALES.length);
    for (const s of SCALES) {
      expect(s.intervals[0]).toBe(0);
      for (let i = 1; i < s.intervals.length; i++) expect(s.intervals[i]).toBeGreaterThan(s.intervals[i - 1]!);
      expect(s.intervals[s.intervals.length - 1]).toBeLessThan(12);
    }
    expect(getScale('nope').id).toBe('major');
  });

  it('knows which keys are in a key', () => {
    // A minor: A B C D E F G.
    expect(scaleNotes(9, 'minor', 57, 69).map(noteName)).toEqual(['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5']);
    expect(inScale(61, 0, 'major')).toBe(false);
    expect(scaleMask(2, 'major-pentatonic').flatMap((on, pc) => (on ? [pc] : []))).toEqual([2, 4, 6, 9, 11]);
    expect(scaleDegree(64, 0, 'major')).toBe(2);
    expect(scaleDegree(63, 0, 'major')).toBeNull();
    expect(keyLabel(1, 'minor')).toBe('C# Minor');
    expect(noteName(60)).toBe('C5');
  });

  it('snaps keys onto the scale, nearest first and ties down', () => {
    expect(snapToScale(61, 0, 'major')).toBe(60); // C# → C (tie)
    expect(snapToScale(61, 0, 'major', 'up')).toBe(62);
    expect(snapToScale(66, 0, 'major')).toBe(65); // F# → F (tie)
    expect(snapToScale(63, 0, 'minor-pentatonic')).toBe(63);
    expect(snapToScale(0, 2, 'major')).toBe(1); // C below D major's lowest C# stays in range
    fc.assert(
      fc.property(key, root, scaleId, fc.constantFrom('nearest', 'up', 'down'), (k, r, s, dir) => {
        const snapped = snapToScale(k, r, s, dir);
        expect(snapped).toBeGreaterThanOrEqual(0);
        expect(snapped).toBeLessThanOrEqual(127);
        expect(inScale(snapped, r, s)).toBe(true);
        expect(snapToScale(snapped, r, s, dir)).toBe(snapped);
        if (dir === 'nearest') {
          const best = Math.min(...scaleNotes(r, s).map((x) => Math.abs(x - k)));
          expect(Math.abs(snapped - k)).toBe(best);
        }
      }),
    );
  });

  it('maps keys to scale steps and back', () => {
    fc.assert(
      fc.property(key, root, scaleId, (k, r, s) => {
        const step = scaleStep(k, r, s);
        const floor = keyAtStep(step, r, s);
        expect(floor).toBeLessThanOrEqual(k);
        expect(inScale(floor, r, s)).toBe(true);
        if (inScale(k, r, s)) expect(floor).toBe(k);
        // The next scale note is above the key.
        expect(keyAtStep(step + 1, r, s)).toBeGreaterThan(k);
      }),
    );
  });

  it('transposes by scale steps and back for keys in the scale', () => {
    fc.assert(
      fc.property(key, root, scaleId, fc.integer({ min: -20, max: 20 }), (k, r, s, n) => {
        const inKey = snapToScale(k, r, s);
        const up = transposeInScale(inKey, n, r, s);
        expect(inScale(up, r, s)).toBe(true);
        expect(transposeInScale(up, -n, r, s)).toBe(inKey);
        // A full scale's worth of steps is an octave.
        const len = getScale(s).intervals.length;
        expect(transposeInScale(inKey, len, r, s)).toBe(inKey + 12);
      }),
    );
    // Out-of-scale notes keep their offset: C# in C major, up a step → D#.
    expect(transposeInScale(61, 1, 0, 'major')).toBe(63);
    expect(pitchClass(-1)).toBe(11);
  });
});
