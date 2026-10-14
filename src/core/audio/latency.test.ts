import { describe, expect, it } from 'vitest';
import { measureRoundTrip, measurementOk } from './latency';

const SR = 48000;

/** A capture starting at `start` (context s) with the clicks played at `times` arriving `delay` later. */
function capture(start: number, times: number[], delay: (i: number) => number, noise = 0.003, level = 0.4) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const x = new Float32Array(5 * SR).map(() => noise * rnd());
  times.forEach((t, i) => {
    const at = Math.round((t + delay(i) - start) * SR);
    for (let k = 0; k < 200 && at + k < x.length; k++) x[at + k] = (x[at + k] as number) + level * Math.exp(-k / 40) * (k % 2 ? -1 : 1);
  });
  return x;
}

describe('latency calibration', () => {
  it('measures the round trip of the clicks it hears', () => {
    const times = [0.5, 0.9, 1.3, 1.7, 2.1, 2.5, 2.9, 3.3];
    const x = capture(0.2, times, (i) => 0.0372 + (i % 3) * 0.0004);
    const m = measureRoundTrip([x], SR, 0.2, times);
    expect(m.found).toBe(8);
    expect(m.ms).toBeCloseTo(37.6, 0);
    expect(m.spreadMs).toBeLessThan(1);
    expect(measurementOk(m)).toBe(true);
  });

  it('refuses a measurement it can’t trust (too quiet, or all over the place)', () => {
    const times = [0.5, 0.9, 1.3, 1.7, 2.1];
    const quiet = measureRoundTrip([capture(0, times, () => 0.03, 0.003, 0.004)], SR, 0, times);
    expect(quiet.found).toBe(0);
    expect(measurementOk(quiet)).toBe(false);
    const wobbly = measureRoundTrip([capture(0, times, (i) => 0.02 + i * 0.01)], SR, 0, times);
    expect(wobbly.found).toBe(5);
    expect(measurementOk(wobbly)).toBe(false);
  });
});
