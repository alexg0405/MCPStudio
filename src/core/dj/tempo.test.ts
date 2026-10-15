import { describe, expect, it } from 'vitest';
import { onsetFeatures } from './onset';
import { trackBeats } from './tempo';
import { PATTERNS, renderTestSong, type DrumPattern, type SongPart } from './test-songs';

const SR = 22050;
const full: SongPart = { bars: 24, kick: true, snare: true, hats: true, bass: true, pads: true };

function track(bpm: number, pattern: DrumPattern, opts: { offset?: number; endBpm?: number; parts?: SongPart[] } = {}) {
  const song = renderTestSong({
    sampleRate: SR,
    bpm,
    pattern,
    parts: opts.parts ?? [full],
    offset: opts.offset ?? 0.37,
    ...(opts.endBpm ? { endBpm: opts.endBpm } : {}),
  });
  const t = trackBeats(onsetFeatures(song.mono, SR));
  return { song, t };
}

/** Largest distance from each true beat to the nearest tracked beat (seconds). */
function worstBeatError(truth: number[], got: number[]): number {
  let worst = 0;
  for (const b of truth) {
    let d = Infinity;
    for (const g of got) d = Math.min(d, Math.abs(g - b));
    worst = Math.max(worst, d);
  }
  return worst;
}

describe('beat tracking', () => {
  const cases: [string, number, DrumPattern][] = [
    ['house', 128, PATTERNS.house],
    ['boom bap (swung)', 90, { ...PATTERNS.boomBap, swing: 0.64 }],
    ['trap half-time', 140, PATTERNS.trap],
    ['drum and bass', 174, PATTERNS.dnb],
    ['reggaeton dembow', 100, PATTERNS.dembow],
    ['pop', 120, PATTERNS.pop],
    ['lo-fi (swung)', 80, { ...PATTERNS.boomBap, swing: 0.62 }],
  ];
  for (const [name, bpm, pattern] of cases)
    it(`finds ${bpm} BPM in ${name}`, () => {
      const { song, t } = track(bpm, pattern);
      expect(t).not.toBeNull();
      expect(t!.drift).toBe(false);
      expect(Math.abs(t!.bpm - bpm)).toBeLessThanOrEqual(0.05);
      // The grid lands on the true beats.
      const phase = (((t!.origin - song.beats[0]!) % t!.period) + t!.period) % t!.period;
      expect(Math.min(phase, t!.period - phase)).toBeLessThan(0.02);
      expect(t!.confidence).toBeGreaterThan(0.5);
    });

  it('follows a slow tempo drift with tracked beats', () => {
    const { song, t } = track(120, PATTERNS.pop, { endBpm: 124, parts: [{ ...full, bars: 48 }] });
    expect(t).not.toBeNull();
    expect(t!.drift).toBe(true);
    expect(worstBeatError(song.beats.slice(1, -1), t!.beats)).toBeLessThan(0.02);
    expect(t!.bpm).toBeGreaterThan(120);
    expect(t!.bpm).toBeLessThan(124);
  });
});
