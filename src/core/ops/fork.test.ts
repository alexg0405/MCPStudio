import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { buildStackedSong } from '../fixtures/stacked-song';
import { createEmptyProject } from '../model/defaults';
import type { ClipId, PatternClip, PatternId, Project } from '../model/types';
import { constantTempo } from '../time/ppq';
import { forkPattern } from './fork';

const BAR = 3840;
const tempo = constantTempo(150);

function stacked() {
  let ids!: ReturnType<typeof buildStackedSong>;
  const p = produce(createEmptyProject(), (d) => {
    ids = buildStackedSong(d);
  });
  return { p, ids };
}

const patternClips = (p: Project, pid: PatternId) =>
  (Object.values(p.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId === pid) as PatternClip[]).sort(
    (a, b) => a.start - b.start || a.laneId.localeCompare(b.laneId),
  );
const bars = (list: PatternClip[]) => list.map((c) => [c.start / BAR + 1, c.length / BAR]);

describe('forkPattern', () => {
  it('copies a pattern for a part: inside clips play the copy, the rest of the song the original', () => {
    const { p, ids } = stacked();
    const drop = ids.patterns.Drop!;
    const before = patternClips(p, drop).length;
    const copy = 'pat_drop37' as PatternId;
    let res!: ReturnType<typeof forkPattern>;
    const q = produce(p, (d) => {
      res = forkPattern(d, drop, { from: 36 * BAR, to: 52 * BAR }, copy, 'Drop (bars 37–52)', tempo);
    });
    expect(res.split).toEqual([]);
    expect(res.moved).toHaveLength(8);
    expect(q.patterns[copy]!.name).toBe('Drop (bars 37–52)');
    // Placed right after the original, with the same notes under fresh ids.
    expect(q.patternOrder.indexOf(copy)).toBe(q.patternOrder.indexOf(drop) + 1);
    const snare = ids.channels.Snare!;
    expect(Object.values(q.patterns[copy]!.notes[snare]!).map((n) => n.tick)).toEqual(
      Object.values(q.patterns[drop]!.notes[snare]!).map((n) => n.tick),
    );
    expect(Object.keys(q.patterns[copy]!.notes[snare]!)).not.toEqual(Object.keys(q.patterns[drop]!.notes[snare]!));
    expect(bars(patternClips(q, copy))).toEqual([37, 39, 41, 43, 45, 47, 49, 51].map((b) => [b, 2]));
    // The Final Drop's 18 clips (three stacked runs) still play the original.
    expect(patternClips(q, drop)).toHaveLength(before - 8);
    expect(patternClips(q, drop).every((c) => c.start >= 88 * BAR)).toBe(true);
  });

  it('splits clips that straddle the edges, keeping their content in place', () => {
    const { p, ids } = stacked();
    const slam = ids.patterns['ISOxo 808 slam']!;
    const copy = 'pat_slam' as PatternId;
    // Bars 18–29: the 2-bar clips at 17 and 29 straddle the edges.
    let res!: ReturnType<typeof forkPattern>;
    const q = produce(p, (d) => {
      res = forkPattern(d, slam, { from: 17 * BAR, to: 29 * BAR }, copy, 'Slam (bars 18–29)', tempo);
    });
    expect(res.split).toHaveLength(2);
    expect(bars(patternClips(q, slam))).toEqual([
      [17, 1],
      [30, 1],
      [31, 2],
    ]);
    const inside = patternClips(q, copy);
    expect(bars(inside)).toEqual([
      [18, 1],
      [19, 2],
      [21, 2],
      [23, 2],
      [25, 2],
      [27, 2],
      [29, 1],
    ]);
    // The piece at bar 18 plays the second bar of the pattern.
    expect(inside[0]!.offset).toBe(BAR);
    expect(patternClips(q, slam)[1]!.offset).toBe(BAR);
  });

  it('moves exactly the clips given, or does nothing for a part the pattern does not play in', () => {
    const { p, ids } = stacked();
    const tom = ids.patterns['Tom fill']!;
    const all = patternClips(p, tom);
    const one = new Set<ClipId>([all[2]!.id]);
    const q = produce(p, (d) => {
      forkPattern(d, tom, { clips: one }, 'pat_tom' as PatternId, 'Tom fill (bar 48)', tempo);
    });
    expect(bars(patternClips(q, 'pat_tom' as PatternId))).toEqual([[48, 1]]);
    expect(patternClips(q, tom)).toHaveLength(all.length - 1);
    const r = produce(p, (d) => {
      const res = forkPattern(d, tom, { from: 0, to: 8 * BAR }, 'pat_none' as PatternId, 'nothing', tempo);
      expect(res).toEqual({ moved: [], split: [] });
    });
    expect(r).toBe(p);
  });
});
