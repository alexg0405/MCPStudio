import { describe, expect, it } from 'vitest';
import { constantTempo } from '@core/time/ppq';
import { steppedTempo } from '@core/time/tempo';
import type { Timeline } from './core';
import { advanceTick, launchPassTempo, retreatTick } from './launch-tempo';

const BAR = 3840;
const stepped = steppedTempo([
  { tick: 0, bpm: 120 },
  { tick: BAR, bpm: 240 },
  { tick: 2 * BAR, bpm: 60 },
]);
const loop2: Timeline = { tempo: stepped, loop: { start: 0, end: 2 * BAR }, endTick: 2 * BAR };
const song: Timeline = { tempo: stepped, loop: null, endTick: 4 * BAR };

describe('launcher axis ↔ song tick', () => {
  it('advances like the planner: wrapping at the loop end, stopping at the end of a song that does not loop', () => {
    expect(advanceTick(loop2, BAR, BAR + 100)).toBe(100);
    expect(advanceTick(loop2, 0, 5 * BAR + 7)).toBe(BAR + 7);
    expect(advanceTick(song, 3 * BAR, 10 * BAR)).toBe(4 * BAR);
    expect(advanceTick(song, 100, 50)).toBe(150);
  });

  it('retreats the same way', () => {
    expect(retreatTick(loop2, 100, 200)).toBe(2 * BAR - 100);
    expect(retreatTick(loop2, 2 * BAR - 100, 200)).toBe(2 * BAR - 300);
    expect(retreatTick(song, 50, 200)).toBe(0);
  });
});

describe('the tempo of a launched pass', () => {
  it('is a constant map when the tempo does not change along the pass (the rounding the clip player relies on for its key)', () => {
    const t = launchPassTempo({ tempo: constantTempo(133.3), loop: null, endTick: 1e9 }, 0, 5000, 9000);
    expect(t.constant).toBe(true);
    expect(t.bpm).toBe(133.3);
    const later = launchPassTempo(song, 2 * BAR + 10, 100, 2000);
    expect(later.constant).toBe(true);
    expect(later.bpm).toBe(60);
  });

  it('follows the song tempo steps along the pass, on the launcher axis', () => {
    // A pass of 3 bars starting at the song's start: u = tick.
    const t = launchPassTempo(song, 0, 0, 3 * BAR);
    expect(t.constant).toBe(false);
    expect([t.bpmAt(10), t.bpmAt(BAR + 10), t.bpmAt(2 * BAR + 10)]).toEqual([120, 240, 60]);
    expect(t.nextChange(0)).toBe(BAR);
    // 2 s + 1 s + 4 s.
    expect(t.tickToSeconds(3 * BAR) - t.tickToSeconds(0)).toBeCloseTo(7, 9);
  });

  it('is on the axis, not on song ticks: a pass starting at u = 10 bars has its change where the song’s is', () => {
    const u0 = 10 * BAR;
    const t = launchPassTempo(song, 0, u0, u0 + 3 * BAR);
    expect(t.nextChange(u0)).toBe(u0 + BAR);
    expect(t.bpmAt(u0 + BAR + 1)).toBe(240);
  });

  it('crosses the loop wrap: the tempo goes back to the loop start’s', () => {
    // A pass of 3 bars from song bar 2 in a two-bar loop: bar 2 at 240 BPM, then the wrap: bar 1 at 120, bar 2 at 240.
    const u0 = 100 * BAR;
    const t = launchPassTempo(loop2, BAR, u0, u0 + 3 * BAR);
    expect([t.bpmAt(u0), t.bpmAt(u0 + BAR), t.bpmAt(u0 + 2 * BAR)]).toEqual([240, 120, 240]);
    expect(t.tickToSeconds(u0 + 3 * BAR) - t.tickToSeconds(u0)).toBeCloseTo(1 + 2 + 1, 9);
  });
});
