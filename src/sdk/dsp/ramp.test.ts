import { describe, expect, it } from 'vitest';
import { Ramp } from './ramp';

/** The values a kernel's per-frame loop produces over one interval of `frames` frames. */
function interval(r: Ramp, frames: number): number[] {
  const out: number[] = [];
  let g = r.value;
  const d = r.slope;
  for (let i = 0; i < frames; i++) out.push((g += d));
  r.land();
  return out;
}

describe('Ramp', () => {
  it('takes its first target at once, and holds a target bit for bit', () => {
    const r = new Ramp();
    r.aim(0.1234567, 32);
    expect(r.slope).toBe(0);
    for (const v of interval(r, 32)) expect(v).toBe(0.1234567);
    // Re-aiming at the same value, interval after interval, never drifts.
    for (let k = 0; k < 1000; k++) {
      r.aim(0.1234567, 32);
      for (const v of interval(r, 32)) expect(v).toBe(0.1234567);
    }
  });

  it('moves in a straight line to a new target and lands on it', () => {
    const r = new Ramp();
    r.aim(1, 32);
    interval(r, 32);
    r.aim(3, 32);
    expect(r.slope).toBeCloseTo(2 / 32, 12);
    const values = interval(r, 32);
    expect(values[0]).toBeCloseTo(1 + 2 / 32, 12);
    for (let i = 1; i < 32; i++) expect((values[i] as number) - (values[i - 1] as number)).toBeCloseTo(2 / 32, 12);
    expect(r.value).toBe(3);
    expect(r.slope).toBe(0);
  });
});
