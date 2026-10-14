import { describe, expect, it } from 'vitest';
import { Rng } from './random';
import { detectSlices, detectSlicesInto, gridSlicesInto, OVERVIEW_BUCKET, peakOverview } from './transients';

const SR = 48000;

/** Decaying noise bursts at `hits` (frames) with the given levels, optional background, `length` frames. */
function bursts(length: number, hits: number[], levels: number[] = [], floor = 0): Float32Array {
  const rng = new Rng(7);
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = floor * rng.bipolar();
  hits.forEach((at, h) => {
    const level = levels[h] ?? 0.8;
    for (let i = at; i < length; i++)
      x[i] = (x[i] as number) + level * rng.bipolar() * Math.exp(-(i - at) / (0.03 * SR));
  });
  return x;
}

const opts = { sensitivity: 0.5, minLength: 0.05, max: 64 };

describe('peakOverview', () => {
  it('is the min and max of every 256-frame bucket over all channels', () => {
    const l = new Float32Array(1000).map((_, i) => Math.sin(i / 30));
    const r = new Float32Array(1000).map((_, i) => 0.5 * Math.cos(i / 7));
    const p = peakOverview([l, r]);
    expect(p.length).toBe(Math.ceil(1000 / OVERVIEW_BUCKET) * 2);
    for (let b = 0; b < 4; b++) {
      let lo = 0;
      let hi = 0;
      for (let i = b * 256; i < Math.min(1000, (b + 1) * 256); i++) {
        lo = Math.min(lo, l[i] as number, r[i] as number);
        hi = Math.max(hi, l[i] as number, r[i] as number);
      }
      expect(p[b * 2]).toBe(Math.fround(lo));
      expect(p[b * 2 + 1]).toBe(Math.fround(hi));
    }
  });
});

describe('detectSlices', () => {
  it('finds every hit within one bucket before it', () => {
    const hits = [0, 12000, 24000, 30000, 41000];
    const x = bursts(SR, hits);
    const slices = detectSlices(peakOverview([x]), OVERVIEW_BUCKET, SR, opts);
    expect(slices).toHaveLength(hits.length);
    slices.forEach((s, i) => {
      expect(s).toBeLessThanOrEqual(hits[i]!);
      expect(hits[i]! - s).toBeLessThan(OVERVIEW_BUCKET);
    });
  });

  it('skips silence before the first hit, but keeps sound before it in the first slice', () => {
    const late = detectSlices(peakOverview([bursts(SR, [9000, 30000])]), OVERVIEW_BUCKET, SR, opts);
    expect(late[0]).toBeGreaterThan(8700);
    expect(late).toHaveLength(2);
    // A quiet pad under everything, then hits: the first slice starts at 0.
    const pad = detectSlices(peakOverview([bursts(SR, [9000, 30000], [], 0.05)]), OVERVIEW_BUCKET, SR, opts);
    expect(pad[0]).toBe(0);
    expect(pad).toHaveLength(3);
  });

  it('more sensitivity finds softer hits, and never fewer slices', () => {
    const x = bursts(SR, [0, 12000, 24000, 36000], [0.9, 0.9, 0.02, 0.9]);
    const peaks = peakOverview([x]);
    let previous = 0;
    for (const sensitivity of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const n = detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, sensitivity }).length;
      expect(n).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
    expect(detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, sensitivity: 0 })).toHaveLength(3);
    expect(detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, sensitivity: 1 })).toHaveLength(4);
  });

  it('merges hits closer than the shortest slice and stops at the maximum', () => {
    // Hits 83 ms and 42 ms apart.
    const x = bursts(SR, [0, 4000, 20000, 22000, 40000]);
    const peaks = peakOverview([x]);
    expect(detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, minLength: 0.005 })).toHaveLength(5);
    expect(detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, minLength: 0.05 })).toHaveLength(4);
    expect(detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, minLength: 0.1 })).toHaveLength(3);
    expect(detectSlices(peaks, OVERVIEW_BUCKET, SR, { ...opts, minLength: 0.005, max: 2 })).toHaveLength(2);
  });

  it('gives one slice at 0 for silence, and works without allocating', () => {
    expect(detectSlices(peakOverview([new Float32Array(5000)]), OVERVIEW_BUCKET, SR, opts)).toEqual([0]);
    const peaks = peakOverview([bursts(SR, [0, 20000])]);
    const out = new Int32Array(8);
    const scratch = new Float64Array(peaks.length / 2);
    expect(detectSlicesInto(peaks, peaks.length / 2, OVERVIEW_BUCKET, SR, opts, out, scratch)).toBe(2);
    expect(out[1]).toBeGreaterThan(19700);
  });
});

describe('gridSlicesInto', () => {
  it('cuts a sample into equal slices', () => {
    const out = new Int32Array(64);
    expect(gridSlicesInto(96000, 16, out)).toBe(16);
    for (let i = 0; i < 16; i++) expect(out[i]).toBe(i * 6000);
    expect(gridSlicesInto(1000, 100, new Int32Array(8))).toBe(8);
  });
});
