import { describe, expect, it } from 'vitest';
import { PATTERNS } from './test-songs';
import { all, analyze, beat } from './analyze-fixtures';

describe('track analysis: sections and mix points', () => {
  it('mixes a DJ-friendly house track in at its start and out at its outro', () => {
    const { song, a } = analyze({
      bpm: 126,
      pattern: PATTERNS.house,
      offset: 0.25,
      parts: [
        { bars: 16, ...beat },
        { bars: 32, ...all, crash: true },
        { bars: 8, pads: true, level: 0.6 },
        { bars: 16, ...all, crash: true },
        { bars: 16, ...beat },
      ],
    });
    const [intro, body, brk, drop, outro] = song.partStarts as [number, number, number, number, number];
    // 88 bars and the 1 s tail.
    expect(a.energy.length).toBe(89);
    expect(Math.abs(a.mixIn - intro)).toBeLessThan(0.02);
    expect(Math.abs(a.mixOut - outro)).toBeLessThan(0.02);
    const near = (t: number) => a.sections.find((s) => Math.abs(s.start - t) < 0.02);
    expect(near(intro)?.kind).toBe('intro');
    expect(near(body)?.kind).toBe('drop');
    expect(near(brk)?.kind).toBe('break');
    expect(near(drop)?.kind).toBe('drop');
    expect(near(outro)?.kind).toBe('outro');
    // Energy follows the arrangement.
    expect(a.energy[20]!).toBeGreaterThan(a.energy[4]! + 0.15);
    expect(a.energy[50]!).toBeLessThan(a.energy[40]! - 0.3);
  });

  it('skips a short intro and mixes out two phrases before a short outro', () => {
    const { song, a } = analyze({
      bpm: 100,
      pattern: PATTERNS.pop,
      offset: 0.5,
      parts: [
        { bars: 4, pads: true, level: 0.6 },
        { bars: 32, ...all },
        { bars: 4, pads: true, level: 0.5 },
      ],
    });
    const barLen = (4 * 60) / 100;
    const [, main, outro] = song.partStarts as [number, number, number];
    expect(Math.abs(a.mixIn - main)).toBeLessThan(0.02);
    // 16 bars before the outro, on the phrase grid that starts after the intro.
    expect(Math.abs(a.mixOut - (outro - 16 * barLen))).toBeLessThan(0.02);
  });
});
