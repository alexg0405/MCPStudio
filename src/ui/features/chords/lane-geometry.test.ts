import { describe, expect, it } from 'vitest';
import type { ChordId } from '@core/model/types';
import { createdSpan, endDraggedSpan, hitChord, movedSpan, snapToGrid, startDraggedSpan } from './lane-geometry';

const BAR = 3840;
const boxes = [
  { id: 'cd_a' as ChordId, left: 0, right: 100 },
  { id: 'cd_b' as ChordId, left: 100, right: 104 },
];

describe('chord lane geometry', () => {
  it('tells the edges and the body of a chord apart, and a thin chord is all body', () => {
    expect(hitChord(boxes, 3)).toEqual({ id: 'cd_a', zone: 'start' });
    expect(hitChord(boxes, 50)).toEqual({ id: 'cd_a', zone: 'body' });
    expect(hitChord(boxes, 97)).toEqual({ id: 'cd_a', zone: 'end' });
    expect(hitChord(boxes, 102)).not.toBeNull();
    expect(hitChord(boxes, 200)).toBeNull();
  });

  it('snaps and keeps chords from going before the start', () => {
    expect(snapToGrid(1000, 960)).toBe(960);
    expect(snapToGrid(1000, 1)).toBe(1000);
    expect(movedSpan({ tick: BAR, length: BAR }, -BAR * 3, BAR / 2)).toEqual({ tick: 0, length: BAR });
    expect(movedSpan({ tick: BAR, length: BAR }, 500, BAR / 4)).toEqual({ tick: BAR + 960, length: BAR });
  });

  it('drags edges and keeps at least one grid step', () => {
    expect(startDraggedSpan({ tick: BAR, length: BAR }, BAR / 2, BAR / 2)).toEqual({ tick: BAR * 1.5, length: BAR / 2 });
    expect(startDraggedSpan({ tick: BAR, length: BAR }, BAR * 5, BAR / 2)).toEqual({ tick: BAR * 1.5, length: BAR / 2 });
    expect(endDraggedSpan({ tick: BAR, length: BAR }, BAR, BAR / 2)).toEqual({ tick: BAR, length: BAR * 2 });
    expect(endDraggedSpan({ tick: BAR, length: BAR }, -BAR * 5, BAR / 2)).toEqual({ tick: BAR, length: BAR / 2 });
  });

  it('makes a chord from a click (a bar, cut where the next begins) or a drag', () => {
    const next = [{ tick: BAR * 1.5, length: BAR }];
    expect(createdSpan(BAR + 10, BAR + 10, BAR / 2, BAR, [])).toEqual({ tick: BAR, length: BAR });
    expect(createdSpan(BAR + 10, BAR + 10, BAR / 2, BAR, next)).toEqual({ tick: BAR, length: BAR / 2 });
    expect(createdSpan(BAR, BAR * 3, BAR / 2, BAR, next)).toEqual({ tick: BAR, length: BAR * 2 });
    expect(createdSpan(BAR * 3, BAR, BAR / 2, BAR, [])).toEqual({ tick: BAR, length: BAR * 2 });
  });
});
