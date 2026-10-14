import { describe, expect, it } from 'vitest';
import { FM_ALGORITHMS, FmOperator, sinCycles } from './fm';

const SR = 48000;

describe('sinCycles', () => {
  it('matches Math.sin to within 1e-6', () => {
    let worst = 0;
    for (let i = -2000; i <= 2000; i++) {
      const c = i / 997;
      worst = Math.max(worst, Math.abs(sinCycles(c) - Math.sin(2 * Math.PI * c)));
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('FmOperator', () => {
  it('is a plain sine without modulation, and phase modulation shifts it', () => {
    const op = new FmOperator();
    for (let i = 0; i < 100; i++)
      expect(op.next(440 / SR, 0, 0.5)).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 440 * i) / SR), 5);
    const shifted = new FmOperator();
    expect(shifted.next(0, Math.PI / 2, 1)).toBeCloseTo(1, 5);
  });

  it('feedback stays bounded and periodic at full amount, and adds harmonics', () => {
    for (const freq of [100, 1000, 4000]) {
      const op = new FmOperator();
      let peak = 0;
      let zeroCrossings = 0;
      let prev = 0;
      // Distance from a pure sine of the same phase.
      let off = 0;
      for (let i = 0; i < SR; i++) {
        const y = op.feedback(freq / SR, 1, 1);
        peak = Math.max(peak, Math.abs(y));
        if (prev < 0 && y >= 0) zeroCrossings++;
        prev = y;
        off += (y - Math.sin((2 * Math.PI * freq * i) / SR)) ** 2 / SR;
      }
      expect(peak).toBeLessThanOrEqual(1 + 1e-6);
      // Still `freq` cycles a second: feedback changes the shape (towards a saw), not the pitch.
      expect(Math.abs(zeroCrossings - freq)).toBeLessThanOrEqual(2);
      expect(off).toBeGreaterThan(0.05);
    }
  });
});

describe('FM_ALGORITHMS', () => {
  /**
   * The documented routings (Yamaha DX21/DX27/DX100/TX81Z), as "source→target" edges between
   * operators numbered 1–4, and the operators that are heard.
   */
  const documented: [edges: string[], carriers: number[]][] = [
    [['4→3', '3→2', '2→1'], [1]],
    [['3→2', '4→2', '2→1'], [1]],
    [['3→2', '2→1', '4→1'], [1]],
    [['4→3', '3→1', '2→1'], [1]],
    [
      ['2→1', '4→3'],
      [1, 3],
    ],
    [
      ['4→1', '4→2', '4→3'],
      [1, 2, 3],
    ],
    [['4→3'], [1, 2, 3]],
    [[], [1, 2, 3, 4]],
  ];

  it('are the eight classic routings', () => {
    expect(FM_ALGORITHMS).toHaveLength(8);
    FM_ALGORITHMS.forEach((alg, i) => {
      const [edges, carriers] = documented[i]!;
      const actual = alg.modulators.flatMap((mods, target) => mods.map((src) => `${src + 1}→${target + 1}`));
      expect(actual.sort()).toEqual([...edges].sort());
      expect(alg.carriers.map((c) => c + 1)).toEqual(carriers);
    });
  });

  it('can be computed top-down: modulators always have higher numbers than their targets', () => {
    for (const alg of FM_ALGORITHMS)
      alg.modulators.forEach((mods, target) => {
        for (const src of mods) expect(src).toBeGreaterThan(target);
      });
  });

  it('every operator is heard or shapes one that is', () => {
    for (const alg of FM_ALGORITHMS) {
      const reaches = (op: number): boolean =>
        alg.carriers.includes(op) || alg.modulators.some((mods, target) => mods.includes(op) && reaches(target));
      for (let op = 0; op < 4; op++) expect(reaches(op)).toBe(true);
    }
  });
});
