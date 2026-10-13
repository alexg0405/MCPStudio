import { describe, expect, it } from 'vitest';
import { curve, driveCompensation, POINTS, RANGE, shape, type CurveKind } from './curves.kernel';

describe('distortion curves', () => {
  for (const kind of ['soft', 'hard', 'fold'] as CurveKind[]) {
    it(`${kind} is odd, silent at 0 and bounded`, () => {
      const c = curve(kind);
      const mid = (POINTS - 1) / 2;
      expect(c.length).toBe(POINTS);
      expect(c[mid]).toBe(0);
      for (let i = 0; i < POINTS; i += 97) {
        expect(c[i]).toBeCloseTo(-(c[POINTS - 1 - i] as number), 6);
        expect(Math.abs(c[i] as number)).toBeLessThanOrEqual(1);
      }
      // Unity slope around 0 for the clippers (quiet signals pass unchanged before the drive).
      const step = RANGE / mid;
      if (kind !== 'fold') expect((c[mid + 1] as number) / step).toBeCloseTo(1, 3);
    });
  }

  it('hard clips at ±1 and folds back past 1', () => {
    expect(shape('hard', 3)).toBe(1);
    expect(shape('hard', -0.5)).toBe(-0.5);
    expect(shape('fold', 1)).toBeCloseTo(1, 12);
    expect(shape('fold', 2)).toBeCloseTo(0, 12);
    expect(shape('fold', 3)).toBeCloseTo(-1, 12);
    expect(shape('soft', 20)).toBeCloseTo(1, 12);
  });

  it('keeps the reference level about constant across drive', () => {
    const level = (driveDb: number) => {
      const g = Math.pow(10, driveDb / 20);
      return Math.abs(shape('hard', 0.25 * g)) * driveCompensation(g);
    };
    for (const db of [0, 6, 12, 24, 36]) expect(level(db)).toBeCloseTo(0.25, 6);
    expect(driveCompensation(1)).toBe(1);
  });
});
