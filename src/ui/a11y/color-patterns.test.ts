import { describe, expect, it } from 'vitest';
import { PALETTE } from '@core/model/defaults';
import { COLOR_PATTERNS, hueOf, patternFor } from './color-patterns';

describe('colour patterns', () => {
  it('reads hue, saturation and value from a hex colour, and nothing else', () => {
    expect(hueOf('#ff0000')).toMatchObject({ hue: 0, saturation: 1, value: 1 });
    expect(hueOf('#00ff00')?.hue).toBeCloseTo(120);
    expect(hueOf('#0000ff')?.hue).toBeCloseTo(240);
    expect(hueOf('#808080')?.saturation).toBe(0);
    expect(hueOf('red')).toBeNull();
    expect(hueOf('#fff')).toBeNull();
  });

  it('sorts colours into hue families, each with its own pattern, and greys into plain', () => {
    expect(patternFor('#e03030')).toBe('backslash');
    expect(patternFor('#f5a030')).toBe('backslash');
    expect(patternFor('#e8d430')).toBe('dots');
    expect(patternFor('#40c040')).toBe('slash');
    expect(patternFor('#30c0c0')).toBe('bars');
    expect(patternFor('#3050e0')).toBe('lines');
    expect(patternFor('#9040e0')).toBe('cross');
    expect(patternFor('#e040a0')).toBe('zigzag');
    expect(patternFor('#888888')).toBe('plain');
    expect(patternFor('#101010')).toBe('plain');
    expect(patternFor('not a colour')).toBe('plain');
  });

  it('tells red from green and the blues from the oranges, which colour blindness confuses', () => {
    expect(patternFor('#c0392b')).not.toBe(patternFor('#27ae60'));
    expect(patternFor('#d35400')).not.toBe(patternFor('#2980b9'));
  });

  it('gives the project palette at least five different patterns', () => {
    const patterns = new Set(PALETTE.map((color) => patternFor(color)));
    expect(patterns.size).toBeGreaterThanOrEqual(5);
    for (const pattern of patterns) expect(COLOR_PATTERNS).toContain(pattern);
  });
});
