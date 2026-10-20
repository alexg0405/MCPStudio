import { describe, expect, it } from 'vitest';
import { MAX_WARP_POINTS, moveAt, warpKnots } from './warp-knots';

const HOP = 0.005;

describe('warpKnots', () => {
  it('keeps the corners of the curve within 2 ms and drops the straight parts', () => {
    const lag = Float32Array.from({ length: 1000 }, (_, i) => (i < 300 ? 0.05 : i < 500 ? 0.05 - (i - 300) * 0.0005 : -0.05));
    const points = warpKnots(lag, HOP, 2);
    expect(points.length / 2).toBeLessThan(12);
    for (let i = 0; i < lag.length; i += 7) {
      const at = 2 + i * HOP;
      expect(Math.abs(moveAt(points, at) - (lag[i] as number) * 1000)).toBeLessThan(2);
    }
    // Times are on the clip's sample, from where the stretch starts.
    expect(points[0]).toBe(2);
  });

  it('stays within the point limit however wiggly the curve is', () => {
    const lag = Float32Array.from({ length: 36_000 }, (_, i) => 0.05 * Math.sin(i * 0.7) * Math.sin(i * 0.013));
    expect(warpKnots(lag, HOP, 0).length / 2).toBeLessThanOrEqual(MAX_WARP_POINTS);
  });

  it('says nothing for a curve with fewer than two frames, and 0 outside the points', () => {
    expect(warpKnots(new Float32Array(1), HOP, 0)).toEqual([]);
    expect(moveAt([], 1)).toBe(0);
    expect(moveAt([1, 10, 2, 20], 0.5)).toBe(0);
    expect(moveAt([1, 10, 2, 20], 1.5)).toBeCloseTo(15, 6);
    expect(moveAt([1, 10, 2, 20], 3)).toBe(0);
  });
});
