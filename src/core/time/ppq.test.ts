import { describe, expect, it } from 'vitest';
import { keyName, parseKeyName } from './ppq';

describe('parseKeyName', () => {
  it('reads note names in FL’s numbering (C5 = 60) and plain key numbers', () => {
    expect(parseKeyName('C5')).toBe(60);
    expect(parseKeyName('c#5')).toBe(61);
    expect(parseKeyName('Bb4')).toBe(58);
    expect(parseKeyName(' F#3 ')).toBe(42);
    expect(parseKeyName('60')).toBe(60);
  });

  it('is the inverse of keyName', () => {
    for (let k = 0; k <= 127; k++) expect(parseKeyName(keyName(k))).toBe(k);
  });

  it('is null for anything else or out of range', () => {
    for (const t of ['', 'H4', 'C', '128', 'G11', 'C-1', 'C#']) expect(parseKeyName(t)).toBeNull();
  });
});
