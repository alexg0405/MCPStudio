import { describe, expect, it } from 'vitest';
import { askPillPlace, pillText } from './ask-pill';

const view = { w: 800, h: 400 };
const pill = { w: 70, h: 20 };

describe('the ✦ Ask AI pill', () => {
  it('sits just above the top-right corner of the selected clips', () => {
    expect(askPillPlace({ x0: 100, x1: 300, y0: 108, y1: 180, compact: false }, pill, view)).toEqual({ x: 230, y: 85 });
  });

  it('goes inside the part’s top edge when there is no room above (the loop region, the first track)', () => {
    expect(askPillPlace({ x0: 100, x1: 300, y0: 0, y1: 0, compact: false }, pill, view)).toEqual({ x: 230, y: 3 });
    expect(askPillPlace({ x0: 100, x1: 300, y0: 10, y1: 46, compact: false }, pill, view)).toEqual({ x: 230, y: 13 });
  });

  it('stays inside the grid when the part reaches past its edges', () => {
    // Ends past the right edge: pinned to it.
    expect(askPillPlace({ x0: 600, x1: 1400, y0: 200, y1: 240, compact: false }, pill, view)).toEqual({ x: 728, y: 177 });
    // Starts before the left edge and is shorter than the pill.
    expect(askPillPlace({ x0: -500, x1: 30, y0: 200, y1: 240, compact: false }, pill, view)).toEqual({ x: 2, y: 177 });
    // Below the visible tracks: pinned to the bottom.
    expect(askPillPlace({ x0: 100, x1: 300, y0: 900, y1: 940, compact: false }, pill, view)).toEqual({ x: 230, y: 378 });
  });

  it('hides while the part is scrolled out of sight sideways', () => {
    expect(askPillPlace({ x0: -400, x1: -10, y0: 50, y1: 80, compact: false }, pill, view)).toBeNull();
    expect(askPillPlace({ x0: 900, x1: 1000, y0: 50, y1: 80, compact: false }, pill, view)).toBeNull();
    expect(askPillPlace({ x0: 10, x1: 50, y0: 50, y1: 80, compact: false }, pill, { w: 60, h: 400 })).toBeNull();
  });

  it('is a compact ✦ for a single clip', () => {
    expect(pillText({ x0: 0, x1: 10, y0: 0, y1: 0, compact: true })).toBe('✦');
    expect(pillText({ x0: 0, x1: 10, y0: 0, y1: 0, compact: false })).toBe('✦ Ask AI');
  });
});
