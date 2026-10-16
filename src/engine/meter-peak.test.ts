import { describe, expect, it } from 'vitest';
import { METER_FRAMES, MeterScratch, peakOf } from './insert-strip';

/** The scan this replaced: the largest |sample|, NaNs ignored. */
function floatPeak(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

function filled(fn: (i: number) => number): MeterScratch {
  const s = new MeterScratch();
  for (let i = 0; i < METER_FRAMES; i++) s.samples[i] = fn(i);
  return s;
}

describe('peakOf (the meters\' peak scan)', () => {
  it('is zero for silence', () => {
    expect(peakOf(new MeterScratch())).toBe(0);
  });

  it('finds the largest magnitude, positive or negative, anywhere in the buffer', () => {
    for (const at of [0, 1, 2, 3, 1000, METER_FRAMES - 1]) {
      expect(peakOf(filled((i) => (i === at ? 0.75 : 0.1)))).toBe(Math.fround(0.75));
      expect(peakOf(filled((i) => (i === at ? -0.9 : 0.2)))).toBe(Math.fround(0.9));
    }
    expect(peakOf(filled((i) => (i % 2 ? -1 : 1) * 0.25))).toBe(0.25);
  });

  it('agrees with a float scan on noise', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    for (let k = 0; k < 20; k++) {
      const s = filled(() => rnd() * (k % 3 === 0 ? 8 : 0.5));
      expect(peakOf(s)).toBe(floatPeak(s.samples));
    }
  });

  it('counts a clipped peak and an infinity, treats negative zero as silence', () => {
    expect(peakOf(filled((i) => (i === 7 ? 3.5 : 0)))).toBe(3.5);
    expect(peakOf(filled((i) => (i === 7 ? -Infinity : 0.5)))).toBe(Infinity);
    expect(peakOf(filled(() => -0))).toBe(0);
  });

  it('ignores NaNs like the float scan did', () => {
    const s = filled((i) => (i === 100 ? NaN : i === 200 ? -0.6 : 0.1));
    expect(peakOf(s)).toBe(Math.fround(0.6));
    expect(peakOf(filled(() => NaN))).toBe(0);
  });
});
