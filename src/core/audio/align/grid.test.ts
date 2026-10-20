import { describe, expect, it } from 'vitest';
import { attackTime, singSyllables, type Syllable } from '../../../../test/helpers/syllables';
import { lagThroughMoves, planGridMoves, tightenToGrid } from './grid';

const SR = 48000;
/** A grid line every half second. */
const GRID_SEC = 0.5;
const nearestGrid = (sec: number) => Math.round(sec / GRID_SEC) * GRID_SEC;

describe('planGridMoves', () => {
  it('moves each onset towards its nearest grid line by the strength, and leaves the far ones', () => {
    const moves = planGridMoves([0.46, 1.07, 1.7], nearestGrid, 100, 0.08);
    expect(moves.map((m) => [m.fromSec, Math.round(m.toSec * 1000) / 1000])).toEqual([
      [0.46, 0.5],
      [1.07, 1.0],
    ]);
    const half = planGridMoves([0.46], nearestGrid, 50, 0.08);
    expect(half[0]?.toSec).toBeCloseTo(0.48, 6);
    expect(planGridMoves([0.46], nearestGrid, 0, 0.08)).toEqual([]);
  });

  it('drops a move that would land on top of the one before', () => {
    const moves = planGridMoves([0.47, 0.5, 0.53], nearestGrid, 100, 0.08);
    // Targets 0.5 and 0.5 and 0.5: only the first is kept (the 0.5 onset is already on the grid).
    expect(moves).toHaveLength(1);
  });
});

describe('lagThroughMoves', () => {
  it('is the move at each onset and 0 away from them', () => {
    const lag = lagThroughMoves([{ fromSec: 1.04, toSec: 1.0 }, { fromSec: 3.0, toSec: 3.05 }], 800, 0.005);
    expect(lag[200]).toBeCloseTo(0.04, 6);
    expect(lag[610]).toBeCloseTo(-0.05, 6);
    expect(lag[0]).toBe(0);
    expect(lag[400]).toBeCloseTo(0, 6);
    expect(lag[799]).toBeCloseTo(0, 6);
  });
});

describe('tightenToGrid', () => {
  /** Ten syllables on a half-second grid, each a little early or late. */
  function loose() {
    const offsets = [0.045, -0.03, 0.06, -0.05, 0.02, -0.06, 0.04, -0.02, 0.055, -0.04];
    const syllables: Syllable[] = offsets.map((o, k) => ({ startSec: 0.5 + k * GRID_SEC + o, durationSec: 0.3, midi: 62 + (k % 3) }));
    return { x: singSyllables(syllables, SR, 6.2), starts: syllables.map((s) => s.startSec) };
  }
  const run = (x: Float32Array, strength: number, maxMoveSec = 0.12) =>
    tightenToGrid({
      channels: [x],
      sampleRate: SR,
      audible: { fromSec: 0, toSec: x.length / SR },
      nearestGridSec: nearestGrid,
      strength,
      maxMoveSec,
    });
  const distance = (x: Float32Array, starts: number[]) => starts.map((t) => attackTime(x, SR, t, 0.07) - nearestGrid(t));

  it('puts the syllable starts within 8 ms of the grid at full strength', () => {
    const { x, starts } = loose();
    const before = distance(x, starts);
    expect(Math.max(...before.map(Math.abs))).toBeGreaterThan(0.04);
    const out = run(x, 100);
    const after = distance(out.channels[0] as Float32Array, starts.map(nearestGrid));
    expect(Math.max(...after.map(Math.abs)), after.map((v) => (v * 1000).toFixed(1)).join(' ')).toBeLessThan(0.008);
    expect(out.channels[0]).toHaveLength(x.length);
  });

  it('goes half way at 50 % and nowhere at 0 %', () => {
    const { x, starts } = loose();
    const before = distance(x, starts);
    const half = distance(run(x, 50).channels[0] as Float32Array, starts.map((t, k) => t + (nearestGrid(t) - t) * 0.5 + 0 * k));
    // Measured around the half-way target: close to it.
    expect(Math.max(...half.map((v, k) => Math.abs(v - (before[k] as number) / 2)))).toBeLessThan(0.012);
    const none = run(x, 0);
    expect(none.stats.movedSec).toBe(0);
    expect(none.channels[0]).toEqual(x);
  });

  it('leaves an onset that is further from the grid than the limit', () => {
    const syllables: Syllable[] = [{ startSec: 0.7, durationSec: 0.3, midi: 62 }];
    const x = singSyllables(syllables, SR, 1.6);
    const out = run(x, 100, 0.1);
    expect(out.channels[0]).toEqual(x);
  });

  it('is deterministic', () => {
    const { x } = loose();
    const a = run(x, 100).channels[0] as Float32Array;
    const b = run(x, 100).channels[0] as Float32Array;
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });
});
