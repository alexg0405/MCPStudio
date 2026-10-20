import { describe, expect, it } from 'vitest';
import { cpuNow, settle } from '../../../test/helpers/perf';
import { analyzeTrack } from './analyze';
import { PATTERNS, renderTestSong } from './test-songs';
import { SR, AM, all, analyze, beat, downbeatError } from './analyze-fixtures';

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

  it('analyzes a 5-minute song in reasonable time', { tags: ['perf'], timeout: 180_000 }, async () => {
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
    // CPU time: on a busy machine the wall clock counts the time spent waiting for a core. The best of up to three runs,
    // stopping at the first fast enough (the machine only ever adds time).
    let a!: ReturnType<typeof analyzeTrack>;
    const ms = await settle(
      () => {
        const t0 = cpuNow();
        a = analyzeTrack({ hash: 'long', mono: song.mono, sampleRate: SR, lufs: -9, truePeakDb: -0.5 });
        return cpuNow() - t0;
      },
      (cpuMs) => cpuMs < 30000,
      { attempts: 3 },
    );
    console.log(`5-minute song analyzed in ${Math.round(ms)} ms of CPU (best run)`);
    expect(a.grid?.bpm).toBe(124);
    expect(ms).toBeLessThan(30000);
  });
});
