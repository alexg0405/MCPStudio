import { describe, expect, it } from 'vitest';
import { parseTypedNumber } from './number-text';

describe('parseTypedNumber', () => {
  it('reads whole numbers, decimals and a decimal comma', () => {
    expect(parseTypedNumber('140')).toBe(140);
    expect(parseTypedNumber('140.5')).toBe(140.5);
    expect(parseTypedNumber(' 140,5 ')).toBe(140.5);
    expect(parseTypedNumber('.5')).toBe(0.5);
    expect(parseTypedNumber('-12')).toBe(-12);
    expect(parseTypedNumber('+3')).toBe(3);
    expect(parseTypedNumber('1e2')).toBe(100);
  });

  it('ignores a unit after the number', () => {
    expect(parseTypedNumber('128 bpm')).toBe(128);
    expect(parseTypedNumber('-3dB')).toBe(-3);
    expect(parseTypedNumber('50%')).toBe(50);
  });

  it('is null for text that is not a number', () => {
    for (const t of ['', '   ', 'abc', '1.2.3', '--', 'bpm 120', '12 34']) expect(parseTypedNumber(t)).toBeNull();
  });
});
