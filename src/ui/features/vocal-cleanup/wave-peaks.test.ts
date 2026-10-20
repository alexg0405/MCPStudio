import { describe, expect, it } from 'vitest';
import { markerAt, peakColumns } from './wave-peaks';

describe('peak columns', () => {
  it('takes the lowest and highest sample of every column over all channels', () => {
    const left = Float32Array.from([0.1, -0.5, 0.2, 0.3, 0, 0, 0.9, -0.1]);
    const right = Float32Array.from([0, 0, 0, -0.7, 0, 0, 0, 0]);
    const peaks = peakColumns([left, right], 4);
    expect(Array.from(peaks)).toEqual(Array.from(Float32Array.from([-0.5, 0.1, -0.7, 0.3, 0, 0, -0.1, 0.9])));
  });

  it('is silent for an empty sound and never leaves a column unvisited when there are more columns than samples', () => {
    expect(Array.from(peakColumns([], 3))).toEqual([0, 0, 0, 0, 0, 0]);
    const peaks = peakColumns([Float32Array.from([0.5, -0.25])], 8);
    expect(peaks.length).toBe(16);
    expect(Math.max(...peaks)).toBe(0.5);
    expect(Math.min(...peaks)).toBe(-0.25);
  });
});

describe('breath markers under a time', () => {
  const spans = [
    { from: 2, to: 2.3 },
    { from: 5, to: 5.01 },
  ];

  it('finds the marker that holds the time, and pads a very short one to a hit-able width', () => {
    expect(markerAt(spans, 2.1, 0.05)).toBe(0);
    expect(markerAt(spans, 4, 0.05)).toBe(-1);
    expect(markerAt(spans, 5.03, 0.1)).toBe(1);
    expect(markerAt(spans, 5.2, 0.1)).toBe(-1);
  });
});
