import { describe, expect, it } from 'vitest';
import { computePeaks, fillPeaks, newWaveform, reducePeaks } from './deck-peaks';

describe('deck peaks', () => {
  it('finds the lowest and highest sample of each bucket', () => {
    const x = new Float32Array(1024);
    x[10] = 0.8;
    x[300] = -0.6;
    x[900] = 0.4;
    const w = computePeaks([x], 48000, 256);
    expect(w.buckets).toBe(4);
    expect(w.max[0]).toBeCloseTo(0.8);
    expect(w.min[1]).toBeCloseTo(-0.6);
    expect(w.max[3]).toBeCloseTo(0.4);
    expect(w.min[0]).toBe(0);
  });

  it('mixes stereo to mono', () => {
    const l = new Float32Array(256).fill(0.5);
    const r = new Float32Array(256).fill(-0.5);
    const w = computePeaks([l, r], 48000, 256);
    expect(w.max[0]).toBeCloseTo(0);
    const same = computePeaks([l, l], 48000, 256);
    expect(same.max[0]).toBeCloseTo(0.5);
  });

  it('knows low from high: a 60 Hz tone is low, a 6 kHz tone is not', () => {
    const sr = 48000;
    const n = sr;
    const bass = new Float32Array(n);
    const hats = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bass[i] = 0.8 * Math.sin((2 * Math.PI * 60 * i) / sr);
      hats[i] = 0.8 * Math.sin((2 * Math.PI * 6000 * i) / sr);
    }
    const a = computePeaks([bass], sr);
    const b = computePeaks([hats], sr);
    expect(a.low[100]).toBeGreaterThan(0.5);
    expect(b.low[100]).toBeLessThan(0.1);
  });

  it('can be filled a slice at a time with the same result', () => {
    const x = new Float32Array(10_000).map((_, i) => Math.sin(i * 0.01));
    const whole = computePeaks([x], 48000);
    const w = newWaveform(x.length, 48000);
    const st = { lp: 0 };
    fillPeaks(w, [x], 0, 10, st);
    fillPeaks(w, [x], 10, w.buckets, st);
    expect(Array.from(w.max)).toEqual(Array.from(whole.max));
    expect(Array.from(w.low)).toEqual(Array.from(whole.low));
  });

  it('reduces to columns keeping the extremes', () => {
    const x = new Float32Array(25_600);
    x[12_800] = 1;
    const w = computePeaks([x], 48000);
    const out = { min: new Float32Array(10), max: new Float32Array(10), low: new Float32Array(10) };
    reducePeaks(w, 10, out);
    expect(out.max[5]).toBe(1);
    expect(out.max[4]).toBe(0);
  });
});
