import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { tempoMapOf } from '../automation/tempo';
import { createEmptyProject } from '../model/defaults';
import { seededBytes, setIdSource } from '../model/ids';
import { buildStackedSong } from '../fixtures/stacked-song';
import { songCheck } from '../query/arrangement';
import { clearRange } from './playlist';
import { tidySong, type TidyReport } from './tidy';

const BAR = 3840;

describe('cleaning up the song', () => {
  setIdSource(seededBytes(3));
  const before = produce(createEmptyProject(), (d) => void buildStackedSong(d));

  it('removes the stacked copies, merges same-curve automation and names one-thing tracks', () => {
    let report!: TidyReport;
    const after = produce(before, (d) => {
      report = tidySong(d);
    });
    expect(Object.keys(before.playlist.clips)).toHaveLength(Object.keys(after.playlist.clips).length + 32);
    expect(report.stacked).toBe(32);
    // Pitch · Riser ×4 → 1, Cutoff · Dark Pad ×3 → 1, Pitch · Downlifter ×3 → 1; the two filter curves differ.
    expect(report.automation).toBe(3 + 2 + 2);
    const auto = Object.values(after.channels).filter((c) => c.kind === 'automation').map((c) => c.name);
    expect(auto.sort()).toEqual(['Cutoff · Dark Pad', 'Cutoff · Filter (Insert 18)', 'Cutoff · Filter (Insert 18)', 'Pitch · Downlifter', 'Pitch · Riser', 'Volume · Master']);
    // Every automation clip still plays (moved to the kept channel).
    const autoClips = Object.values(after.playlist.clips).filter((c) => c.kind === 'automation');
    expect(autoClips).toHaveLength(Object.values(before.playlist.clips).filter((c) => c.kind === 'automation').length);
    expect(autoClips.every((c) => after.channels[c.channelId])).toBe(true);
    expect(report.named.map((n) => n.name)).toEqual([
      'Choir layer',
      'Strings layer',
      'Organ layer',
      'Riser',
      'Impact',
      'Bell layer',
      'Perc layer',
      'Tom fill',
      'Downlifter',
    ]);
    // Track 1 keeps one copy of the tail; Track 11 is empty now.
    const track1 = Object.values(after.playlist.clips).filter((c) => c.laneId === after.playlist.laneOrder[0]);
    expect(track1).toHaveLength(56);
    expect(Object.values(after.playlist.clips).some((c) => c.laneId === after.playlist.laneOrder[10])).toBe(false);
    expect(songCheck(after).filter((i) => i.kind === 'stacked' || i.kind === 'duplicateAutomation')).toEqual([]);
  });

  it('clears a bar range, trimming clips at the edges', () => {
    const lane = before.playlist.laneOrder[0]!;
    let res!: { removed: number; cut: number };
    const after = produce(before, (d) => {
      res = clearRange(d, 36 * BAR + BAR / 2, 40 * BAR, { lanes: new Set([lane]), trim: true, tempo: tempoMapOf(before, 'song') });
    });
    const clips = Object.values(after.playlist.clips)
      .filter((c) => c.laneId === lane && c.start < 44 * BAR && c.start + c.length > 32 * BAR)
      .sort((a, b) => a.start - b.start)
      .map((c) => [c.start / BAR + 1, c.length / BAR, c.kind === 'pattern' ? c.offset / BAR : 0]);
    expect(res).toEqual({ removed: 2, cut: 1 });
    // Bars 33–36 (Build), half of bar 37 left of the cut, then bars 41–44 untouched.
    expect(clips).toEqual([
      [33, 2, 0],
      [35, 2, 0],
      [37, 0.5, 0],
      [41, 2, 0],
      [43, 2, 0],
    ]);
  });
});
