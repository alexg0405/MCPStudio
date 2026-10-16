import { describe, expect, it } from 'vitest';
import { placeAtPointer } from './place';

describe('placeAtPointer', () => {
  it('opens below and right of the pointer when it fits', () => {
    expect(placeAtPointer(100, 200, 200, 180, 1280, 800)).toEqual({ left: 100, top: 200 });
  });

  it('flips above the pointer near the bottom and left of it near the right edge', () => {
    expect(placeAtPointer(1200, 700, 200, 180, 1280, 800)).toEqual({ left: 1000, top: 520 });
  });

  it('stays inside the viewport when it fits neither way', () => {
    expect(placeAtPointer(50, 100, 200, 500, 300, 520)).toEqual({ left: 50, top: 16 });
    expect(placeAtPointer(-20, -5, 200, 100, 1280, 800)).toEqual({ left: 4, top: 4 });
  });
});
