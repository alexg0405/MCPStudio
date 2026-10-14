import { describe, expect, it } from 'vitest';
import { buildStackedSong } from '@core/fixtures/stacked-song';
import type { Clip } from '@core/model/types';
import { songCheck } from '@core/query/arrangement';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

const BAR = 3840;

function stackedSong() {
  const s = createTestServices();
  let ids!: ReturnType<typeof buildStackedSong>;
  s.history.transact('song', (d) => {
    ids = buildStackedSong(d);
  });
  return { s, ids };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const clips = (s: ReturnType<typeof createTestServices>) => Object.values(s.doc.getState().project.playlist.clips) as Clip[];
const onTrack = (s: ReturnType<typeof createTestServices>, n: number) =>
  clips(s)
    .filter((c) => c.laneId === s.doc.getState().project.playlist.laneOrder[n - 1])
    .sort((a, b) => a.start - b.start);

describe('placing patterns', () => {
  it("won't stack a pattern on itself: placing the song's tail again (as the AI did) adds nothing", () => {
    const { s } = stackedSong();
    const before = clips(s).length;
    const res = run(s, [
      { op: 'place_pattern', pattern: 'Drop', bar: 89, times: 6 },
      { op: 'place_pattern', pattern: 'Drop', bar: 89, track: 1, times: 6 },
    ]);
    expect(clips(s)).toHaveLength(before);
    expect(res.warnings).toEqual([
      'place pattern: “Drop” already plays at bars 89–100, so nothing was added (it would play twice)',
      'place pattern: “Drop” already plays at bars 89–100, so nothing was added (it would play twice)',
    ]);
    expect(onTrack(s, 12)).toHaveLength(0);
  });

  it('places the free part and says what it skipped', () => {
    const { s } = stackedSong();
    const res = run(s, [{ op: 'place_pattern', pattern: 'Verse? no', bar: 1 }, { op: 'place_pattern', pattern: 'Build', bar: 31, times: 3 }]);
    expect(res.changes).toEqual(['Placed “Build” on track 4 at bar 31 ×1 (skipped bars 33–36: it already plays there)']);
    expect(res.warnings).toEqual(['place pattern: there is no pattern "Verse? no"']);
  });

  it('fails on a track that does not exist, and replaces a track’s clips when asked', () => {
    const { s } = stackedSong();
    const missing = run(s, [{ op: 'place_pattern', pattern: 'Drop', bar: 1, track: 40 }]);
    expect(missing.warnings).toEqual(['place pattern: there is no playlist track 40 (there are 18)']);
    const res = run(s, [{ op: 'place_pattern', pattern: 'Break', bar: 37, track: 1, times: 2, replace: true }]);
    expect(res.warnings).toEqual([]);
    const track1 = onTrack(s, 1).map((c) => [c.start / BAR + 1, c.kind === 'pattern' ? s.doc.getState().project.patterns[c.patternId]!.name : '']);
    expect(track1.filter(([bar]) => (bar as number) >= 35 && (bar as number) < 45)).toEqual([
      [35, 'Build'],
      [37, 'Break'],
      [39, 'Break'],
      [41, 'Drop'],
      [43, 'Drop'],
    ]);
  });
});

describe('clearing the playlist', () => {
  it('fails on a missing track instead of clearing every track', () => {
    const { s } = stackedSong();
    const before = clips(s).length;
    const res = run(s, [{ op: 'clear_playlist', from_bar: 1, to_bar: 8, track: 30 }]);
    expect(res.warnings).toEqual(['clear playlist: there is no playlist track 30 (there are 18)']);
    expect(clips(s)).toHaveLength(before);
  });

  it('trims clips at the edges when asked', () => {
    const { s } = stackedSong();
    const res = run(s, [{ op: 'clear_playlist', from_bar: 38, to_bar: 38, track: 1, trim: true }]);
    expect(res.changes).toEqual(['Removed 1 playlist clip (1 cut at the edges)']);
    const around = onTrack(s, 1)
      .filter((c) => c.start >= 36 * BAR && c.start < 40 * BAR)
      .map((c) => [c.start / BAR + 1, c.length / BAR]);
    expect(around).toEqual([
      [37, 1],
      [39, 2],
    ]);
  });
});

describe('one clip at a time', () => {
  it('makes one repeat of a loop its own, so a fill changes only that spot', () => {
    const { s, ids } = stackedSong();
    const res = run(s, [
      { op: 'clip', action: 'make_unique', track: 1, bar: 51, ref: '@fill' },
      { op: 'write_notes', pattern: '@fill', channel: 'Snare', replace: true, notes: [16, 18, 20, 22, 24, 26, 28, 29, 30, 31].map((step) => ({ step, vel: 0.6 + step / 100 })) },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]).toBe('“Drop” (track 1, bar 51) now plays its own copy, “Drop (bar 51)”');
    const p = s.doc.getState().project;
    const at51 = onTrack(s, 1).find((c) => c.start === 50 * BAR)!;
    expect(at51.kind === 'pattern' && p.patterns[at51.patternId]!.name).toBe('Drop (bar 51)');
    // The other seven repeats still play the original, unchanged.
    const drops = onTrack(s, 1).filter((c) => c.kind === 'pattern' && c.patternId === ids.patterns.Drop);
    expect(drops.length).toBeGreaterThan(7);
    expect(Object.keys(p.patterns[ids.patterns.Drop!]!.notes[ids.channels.Snare!]!)).toHaveLength(4);
  });

  it('splits, mutes, moves, shortens and removes clips by track and bar', () => {
    const { s } = stackedSong();
    const res = run(s, [
      { op: 'clip', action: 'split', track: 9, bar: 16, at_bar: 16.5 },
      { op: 'clip', action: 'edit', track: 6, bar: 17, mute: true },
      { op: 'clip', action: 'edit', track: 5, bar: 15, to_track: 12, to_bar: 14, bars: 3 },
      { op: 'clip', action: 'remove', track: 10, bar: 54 },
      { op: 'clip', action: 'split', track: 9, bar: 16, at_bar: 40 },
      { op: 'clip', action: 'edit', track: 13, bar: 1 },
    ]);
    expect(res.changes).toEqual([
      'Split “Tom fill” (track 9, bar 16) at bar 16.5',
      '“Impact” (track 6, bar 17): muted',
      '“Riser” (track 5, bar 15): to track 12, starts at bar 14, 3 bars long',
      'Removed “Downlifter” (track 10, bar 53)',
    ]);
    expect(res.warnings).toEqual([
      "clip: bar 40 isn't inside that clip (it plays from bar 16 to 16.5)",
      'clip: nothing plays on track 13 at bar 1',
    ]);
  });

  it('names tracks and cleans up the stacked song in one undo step', () => {
    const { s } = stackedSong();
    const res = run(s, [{ op: 'tidy' }, { op: 'track', track: 1, name: 'Main loop', color: '#aa3344' }]);
    expect(res.changes).toEqual([
      'Cleaned up the song: removed 32 stacked copies, merged 7 repeated automation channels, named 9 tracks',
      'Track 1: named “Main loop”',
    ]);
    const p = s.doc.getState().project;
    expect(songCheck(p).map((i) => i.kind)).not.toContain('stacked');
    s.history.undo();
    expect(songCheck(s.doc.getState().project).map((i) => i.kind)).toContain('stacked');
  });
});

describe('the current pattern', () => {
  it('follows a pattern made earlier in the same answer', () => {
    const { s } = stackedSong();
    const res = run(s, [
      { op: 'add_pattern', name: 'Hook', bars: 2 },
      { op: 'write_notes', pattern: 'current', channel: 'Kick', notes: [{ step: 0 }, { step: 8 }] },
      { op: 'place_pattern', pattern: 'current', bar: 113 },
    ]);
    expect(res.changes).toEqual(['Added pattern “Hook”', 'Wrote 2 notes for “Kick” in “Hook”', 'Placed “Hook” on track 1 at bar 113']);
  });
});
