import { describe, expect, it } from 'vitest';
import {
  frameFromHarmonics,
  harmonicAmps,
  isSilent,
  MAX_FRAMES,
  peakOf,
  type Frame,
} from '@agstudio/sdk/dsp/wavetable-frames';
import {
  addFrameAfter,
  basicShapesTable,
  fillBetween,
  moveFrame,
  removeFrameAt,
  replaceFrame,
  shapeWave,
  startingFrame,
  STARTING_SHAPES,
} from './table-edit';

const marked = (n: number): Frame => frameFromHarmonics([n]);
const tags = (frames: readonly Frame[]) => frames.map((f) => f.sin[1]);

describe('table editor: the key-frame list', () => {
  it('adding a frame copies the selected one after it; an empty table starts with a sine', () => {
    expect(tags(addFrameAfter([], 0).frames)).toEqual([1]);
    const r = addFrameAfter([marked(1), marked(2)], 0);
    expect(tags(r.frames)).toEqual([1, 1, 2]);
    expect(r.selected).toBe(1);
    const copy = r.frames[1] as Frame;
    copy.sin[1] = 9;
    expect((r.frames[0] as Frame).sin[1]).toBe(1);
  });

  it('stops adding at the frame limit', () => {
    const full = Array.from({ length: MAX_FRAMES }, (_, i) => marked(i + 1));
    expect(addFrameAfter(full, 3).frames).toHaveLength(MAX_FRAMES);
  });

  it('removes the selected frame and keeps the last one', () => {
    const r = removeFrameAt([marked(1), marked(2), marked(3)], 2);
    expect(tags(r.frames)).toEqual([1, 2]);
    expect(r.selected).toBe(1);
    expect(removeFrameAt([marked(7)], 0).frames).toHaveLength(1);
  });

  it('moves a frame earlier or later and stays at the ends', () => {
    const f = [marked(1), marked(2), marked(3)];
    const r = moveFrame(f, 1, 1);
    expect(tags(r.frames)).toEqual([1, 3, 2]);
    expect(r.selected).toBe(2);
    expect(tags(moveFrame(f, 0, -1).frames)).toEqual([1, 2, 3]);
    expect(moveFrame(f, 2, 1).selected).toBe(2);
  });

  it('replacing a frame leaves the others alone', () => {
    const r = replaceFrame([marked(1), marked(2)], 1, marked(5));
    expect(tags(r.frames)).toEqual([1, 5]);
    expect(replaceFrame([], 0, marked(4)).frames).toHaveLength(1);
  });

  it('filling between inserts evenly spaced frames and keeps the key frames where they were', () => {
    const r = fillBetween([marked(0), marked(4)], 0, 3);
    expect(tags(r.frames)).toEqual([0, 1, 2, 3, 4]);
    expect(r.selected).toBe(0);
    // Nothing after the last frame to fill towards.
    expect(fillBetween([marked(1), marked(2)], 1, 3).frames).toHaveLength(2);
    // Only as many as fit under the limit.
    const nearlyFull = Array.from({ length: MAX_FRAMES - 1 }, (_, i) => marked(i));
    expect(fillBetween(nearlyFull, 0, 10).frames).toHaveLength(MAX_FRAMES);
  });
});

describe('table editor: starting shapes', () => {
  it('every shape is a cycle with no DC and a peak of 1', () => {
    for (const [id] of STARTING_SHAPES) {
      const f = startingFrame(id);
      expect(isSilent(f), id).toBe(false);
      expect(f.cos[0], id).toBe(0);
      expect(peakOf(f), id).toBeCloseTo(1, 6);
    }
  });

  it('saw has harmonics at 1/k, square only the odd ones, the random shape is the same every time', () => {
    const saw = harmonicAmps(startingFrame('saw'), 6);
    for (let k = 2; k <= 6; k++) expect((saw[k - 1] as number) * k).toBeCloseTo(saw[0] as number, 1);
    const square = harmonicAmps(startingFrame('square'), 6);
    expect(square[1]).toBeLessThan(1e-6);
    expect(square[2]).toBeGreaterThan(0.1);
    expect(shapeWave('noise')).toEqual(shapeWave('noise'));
  });

  it('"start from Basic shapes" is a sine, a triangle, a saw and a square', () => {
    const t = basicShapesTable();
    expect(t).toHaveLength(4);
    expect(harmonicAmps(t[0] as Frame, 3)[1]).toBeLessThan(1e-9);
  });
});
