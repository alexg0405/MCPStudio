import { describe, expect, it } from 'vitest';
import { PATTERNS, type DrumPattern, type TestSongSpec } from './test-songs';
import { ANALYSIS_VERSION } from './types';
import { all, analyze, downbeatError } from './analyze-fixtures';

describe('track analysis: downbeats', () => {
  const cases: [string, number, DrumPattern, Partial<TestSongSpec>][] = [
    ['house', 128, PATTERNS.house, { offset: 0.37 }],
    ['boom bap with a pickup', 90, { ...PATTERNS.boomBap, swing: 0.64 }, { offset: 1.9, pickup: true }],
    ['trap half-time', 140, PATTERNS.trap, { offset: 0.81 }],
    ['drum and bass', 174, PATTERNS.dnb, { offset: 0.05 }],
    ['reggaeton', 100, PATTERNS.dembow, { offset: 1.234 }],
    ['pop', 118, PATTERNS.pop, { offset: 0.6 }],
  ];
  for (const [name, bpm, pattern, extra] of cases)
    it(`finds the first downbeat of ${name}`, () => {
      const { song, a } = analyze({ bpm, pattern, parts: [{ bars: 24, ...all }], ...extra });
      expect(a.version).toBe(ANALYSIS_VERSION);
      expect(a.grid).not.toBeNull();
      expect(Math.abs(a.grid!.bpm - bpm)).toBeLessThanOrEqual(0.05);
      expect(a.grid!.beatsPerBar).toBe(4);
      const { error, bar } = downbeatError(song.downbeats, a.grid!.firstDownbeat);
      expect(error).toBeLessThan(0.02);
      expect(bar).toBe(0);
      expect(a.key?.camelot).toBe('8A');
    });

  it('detects 3/4', () => {
    const { song, a } = analyze({ bpm: 150, pattern: PATTERNS.waltz, beatsPerBar: 3, parts: [{ bars: 32, ...all }], offset: 0.4 });
    expect(a.grid?.beatsPerBar).toBe(3);
    expect(downbeatError(song.downbeats, a.grid!.firstDownbeat).error).toBeLessThan(0.02);
  });
});
