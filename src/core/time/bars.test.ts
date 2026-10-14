import { describe, expect, it } from 'vitest';
import { barOf, barSpan } from './bars';

const ts = { num: 4, den: 4 };
const BAR = 3840;

describe('bar numbers', () => {
  it('are 1-based and inclusive', () => {
    expect(barSpan(80 * BAR, 112 * BAR, ts)).toBe('bars 81–112');
    expect(barSpan(8 * BAR, 9 * BAR, ts)).toBe('bar 9');
    expect(barSpan(16.25 * BAR, 19.5 * BAR, ts)).toBe('bar 17.25 to 20.5');
    expect(barOf(16.5 * BAR, ts)).toBe(17.5);
    expect(barSpan(0, 3 * 2880, { num: 3, den: 4 })).toBe('bars 1–3');
  });
});
