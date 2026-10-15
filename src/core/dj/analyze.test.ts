import { describe, expect, it } from 'vitest';
import { analyzeTrack } from './analyze';
import { MAJOR, MINOR, PATTERNS, chord, renderTestSong, type DrumPattern, type SongPart, type TestSongSpec } from './test-songs';
import { ANALYSIS_VERSION } from './types';

const SR = 22050;
const all: Omit<SongPart, 'bars'> = { kick: true, snare: true, hats: true, bass: true, pads: true };
const beat: Omit<SongPart, 'bars'> = { kick: true, hats: true, level: 0.7 };
/** Am – Dm – E – Am (A minor, one chord per bar). */
const AM = [chord(57, MINOR), chord(50, MINOR), chord(52, MAJOR), chord(57, MINOR)];

function analyze(spec: Partial<TestSongSpec> & Pick<TestSongSpec, 'bpm' | 'pattern' | 'parts'>) {
  const song = renderTestSong({ sampleRate: SR, chords: AM, ...spec });
  const a = analyzeTrack({ hash: 'test', mono: song.mono, sampleRate: SR, lufs: -10, truePeakDb: -1 });
  return { song, a };
}

/** Distance (seconds) from the analysis' first downbeat to the true downbeat nearest it, and the bar index. */
function downbeatError(downbeats: number[], t: number): { error: number; bar: number } {
  let bar = 0;
  for (let i = 1; i < downbeats.length; i++) if (Math.abs(downbeats[i]! - t) < Math.abs(downbeats[bar]! - t)) bar = i;
  return { error: Math.abs(downbeats[bar]! - t), bar };
}

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

describe('track analysis: hard cases', () => {
  it('returns the tracked beats when the tempo drifts', () => {
    const { song, a } = analyze({ bpm: 120, endBpm: 124, pattern: PATTERNS.pop, offset: 0.3, parts: [{ bars: 48, ...all }] });
    expect(a.grid!.beats.length).toBeGreaterThan(150);
    expect(downbeatError(song.downbeats, a.grid!.firstDownbeat)).toEqual({ error: expect.any(Number), bar: 0 });
    for (const b of song.beats.slice(1, -1)) {
      const d = Math.min(...a.grid!.beats.map((x) => Math.abs(x - b)));
      expect(d).toBeLessThan(0.02);
    }
    // Bars follow the tracked downbeats.
    expect(a.energy.length).toBeGreaterThanOrEqual(48);
  });

  it('has no grid for a beatless pad, and energy every 2 s', () => {
    const { a } = analyze({ bpm: 70, pattern: PATTERNS.pop, parts: [{ bars: 8, pads: true }] });
    expect(a.grid).toBeNull();
    expect(a.energy.length).toBe(Math.ceil(a.durationSec / 2));
    expect(a.key?.mode).toBe('minor');
  });

  it('analyzes a 5-minute song in reasonable time', () => {
    const song = renderTestSong({
      sampleRate: SR,
      bpm: 124,
      pattern: PATTERNS.house,
      chords: AM,
      parts: [
        { bars: 32, ...beat },
        { bars: 64, ...all },
        { bars: 16, pads: true },
        { bars: 32, ...all },
        { bars: 11, ...beat },
      ],
    });
    expect(song.durationSec).toBeGreaterThan(299);
    const t0 = performance.now();
    const a = analyzeTrack({ hash: 'long', mono: song.mono, sampleRate: SR, lufs: -9, truePeakDb: -0.5 });
    const ms = performance.now() - t0;
    console.log(`5-minute song analyzed in ${Math.round(ms)} ms`);
    expect(a.grid?.bpm).toBe(124);
    expect(ms).toBeLessThan(15000);
  }, 60_000);
});
