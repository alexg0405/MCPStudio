import { describe, expect, it } from 'vitest';
import type { LyricId, LyricWord } from '@core/model/types';
import { createdSpan, hitWord, movedSpan, spansOf } from './lane-geometry';

const boxes = [
  { id: 'ly_a' as LyricId, left: 0, right: 60 },
  { id: 'ly_b' as LyricId, left: 60, right: 64 },
];

describe('lyrics lane geometry', () => {
  it('tells the edges and the body of a word apart, and a thin word is all body', () => {
    expect(hitWord(boxes, 3)).toEqual({ id: 'ly_a', zone: 'start' });
    expect(hitWord(boxes, 30)).toEqual({ id: 'ly_a', zone: 'body' });
    expect(hitWord(boxes, 57)).toEqual({ id: 'ly_a', zone: 'end' });
    expect(hitWord(boxes, 62)).not.toBeNull();
    expect(hitWord(boxes, 200)).toBeNull();
  });

  it('a word made by a click is a beat long, cut short where the next word starts; dragging sets the length; a drag cannot go before 0', () => {
    const next = spansOf([{ tick: 700, length: 100 } as LyricWord]);
    expect(createdSpan(0, 0, 240, 960, next)).toEqual({ tick: 0, length: 700 });
    expect(createdSpan(1000, 1000, 240, 960, next)).toEqual({ tick: 960, length: 960 });
    expect(createdSpan(0, 1000, 240, 960, [])).toEqual({ tick: 0, length: 960 });
    expect(movedSpan({ tick: 100, length: 480 }, -500, 1)).toEqual({ tick: 0, length: 480 });
  });
});
