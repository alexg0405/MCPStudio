import { describe, expect, it } from 'vitest';
import { Noise, type NoiseColor } from './noise';
import { SampleReader } from './sample-reader';

/** Energy of the first difference relative to the signal: higher means brighter. */
function brightness(x: Float32Array): number {
  let e = 0;
  let d = 0;
  for (let i = 1; i < x.length; i++) {
    e += (x[i] as number) ** 2;
    d += ((x[i] as number) - (x[i - 1] as number)) ** 2;
  }
  return d / e;
}

function noise(color: NoiseColor, seed = 3, n = 48000): Float32Array {
  const g = new Noise(seed, color);
  return Float32Array.from({ length: n }, () => g.next());
}

describe('Noise', () => {
  it('repeats exactly for the same seed and differs for another', () => {
    expect(noise('pink')).toEqual(noise('pink'));
    expect(noise('white', 3)).not.toEqual(noise('white', 4));
    const g = new Noise(9);
    const first = [g.next(), g.next()];
    g.seed(9);
    expect([g.next(), g.next()]).toEqual(first);
  });

  it('stays in about −1…1 with no DC, and darkens from white to pink to brown', () => {
    for (const color of ['white', 'pink', 'brown'] as const) {
      const x = noise(color);
      let mean = 0;
      let peak = 0;
      for (const v of x) {
        mean += v / x.length;
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak).toBeLessThan(1.5);
      expect(peak).toBeGreaterThan(0.2);
      expect(Math.abs(mean)).toBeLessThan(0.05);
    }
    const w = brightness(noise('white'));
    const p = brightness(noise('pink'));
    const b = brightness(noise('brown'));
    expect(w).toBeGreaterThan(1.8); // white: E[(x_i − x_{i−1})²] = 2·E[x²]
    expect(p).toBeLessThan(w / 2);
    expect(b).toBeLessThan(p / 4);
  });
});

describe('SampleReader', () => {
  const ramp = Float32Array.from({ length: 100 }, (_, i) => i);
  const read = (r: SampleReader) => {
    const out: number[] = [];
    while (r.next()) out.push(r.l);
    return out;
  };

  it('plays a region forwards and backwards at speed 1', () => {
    const r = new SampleReader();
    r.play([ramp], 10, 20, 1);
    expect(r.remaining).toBe(10);
    expect(read(r)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(r.active).toBe(false);
    r.play([ramp], 10, 20, 1, true);
    expect(read(r)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
  });

  it('interpolates between frames at other speeds', () => {
    const r = new SampleReader();
    r.play([ramp], 0, 4, 0.5);
    expect(read(r)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3]);
    r.play([ramp], 0, 100, 2);
    expect(read(r)).toHaveLength(50);
  });

  it('gives both channels of a stereo sample and the same value twice for mono', () => {
    const r = new SampleReader();
    const right = Float32Array.from(ramp, (v) => -v);
    r.play([ramp, right], 5, 7, 1);
    r.next();
    expect([r.l, r.r]).toEqual([5, -5]);
    r.play([ramp], 5, 7, 1);
    r.next();
    expect([r.l, r.r]).toEqual([5, 5]);
    expect(r.progress).toBeCloseTo(0.5, 9);
  });

  it('refuses empty regions and stops on request', () => {
    const r = new SampleReader();
    r.play([ramp], 50, 50, 1);
    expect(r.active).toBe(false);
    r.play([], 0, 10, 1);
    expect(r.active).toBe(false);
    r.play([ramp], 0, 10, 1);
    r.stop();
    expect(r.next()).toBe(false);
    expect(r.l).toBe(0);
  });
});
