import { describe, expect, it } from 'vitest';
import { firstEndingAfter } from './spans';

const spans = [
  { tick: 0, length: 10 },
  { tick: 10, length: 10 },
  { tick: 30, length: 5 },
];

describe('firstEndingAfter', () => {
  it('finds the first span that is not wholly to the left of the tick', () => {
    expect(firstEndingAfter(spans, 0)).toBe(0);
    expect(firstEndingAfter(spans, 9)).toBe(0);
    expect(firstEndingAfter(spans, 10)).toBe(1);
    expect(firstEndingAfter(spans, 20)).toBe(2);
    expect(firstEndingAfter(spans, 34)).toBe(2);
    expect(firstEndingAfter(spans, 35)).toBe(3);
  });

  it('handles an empty list', () => {
    expect(firstEndingAfter([], 5)).toBe(0);
  });
});
