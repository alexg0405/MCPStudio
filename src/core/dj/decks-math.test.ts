import { describe, expect, it } from 'vitest';
import {
  alignOffsetSec,
  autoLoopSpan,
  beatJumpTarget,
  beatPhase,
  crossfaderGainFor,
  crossfaderGains,
  cuePressPlan,
  faderGain,
  filterCutoffs,
  formatDeckTime,
  formatPitch,
  liveMixTitle,
  loopBeats,
  loopBeatsLabel,
  manualLoopSpan,
  nudgeBend,
  octaveMultiple,
  phaseDiff,
  rangeFor,
  resizeLoop,
  scratchRate,
  shiftLoop,
  snapToGrid,
  syncPlan,
  wrapIntoLoop,
  deckGridOf,
  hotCuePosition,
  type DeckGrid,
} from './decks-math';
import { driftingBeats } from './beat-map';

const grid: DeckGrid = { bpm: 120, firstDownbeat: 0.25 }; // a beat is 0.5 s

describe('crossfader', () => {
  it('is all A at −1 and all B at +1, for both curves', () => {
    for (const curve of ['smooth', 'sharp'] as const) {
      expect(crossfaderGains(-1, curve)).toEqual({ a: 1, b: 0 });
      expect(crossfaderGains(1, curve)).toEqual({ a: 0, b: 1 });
    }
  });

  it('smooth is equal power: the sum of squares stays 1 and the middle is −3 dB', () => {
    for (let x = -1; x <= 1; x += 0.05) {
      const g = crossfaderGains(x, 'smooth');
      expect(g.a * g.a + g.b * g.b).toBeCloseTo(1, 9);
    }
    const mid = crossfaderGains(0, 'smooth');
    expect(mid.a).toBeCloseTo(Math.SQRT1_2, 9);
    expect(mid.b).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('sharp keeps both sides at full until the outer 10 %', () => {
    expect(crossfaderGains(0, 'sharp')).toEqual({ a: 1, b: 1 });
    expect(crossfaderGains(0.8, 'sharp').a).toBe(1);
    expect(crossfaderGains(0.95, 'sharp').a).toBeCloseTo(0.5, 9);
    expect(crossfaderGains(-0.95, 'sharp').b).toBeCloseTo(0.5, 9);
  });

  it('never moves backwards: A only falls, B only rises as the fader goes right', () => {
    for (const curve of ['smooth', 'sharp'] as const) {
      let prev = crossfaderGains(-1, curve);
      for (let x = -0.99; x <= 1; x += 0.01) {
        const g = crossfaderGains(x, curve);
        expect(g.a).toBeLessThanOrEqual(prev.a + 1e-12);
        expect(g.b).toBeGreaterThanOrEqual(prev.b - 1e-12);
        prev = g;
      }
    }
  });

  it('a deck on thru is not affected', () => {
    expect(crossfaderGainFor('thru', -1, 'smooth')).toBe(1);
    expect(crossfaderGainFor('thru', 1, 'sharp')).toBe(1);
    expect(crossfaderGainFor('B', -1, 'smooth')).toBe(0);
    expect(crossfaderGainFor('A', 1, 'smooth')).toBe(0);
  });

  it('clamps nonsense positions', () => {
    expect(crossfaderGains(-5, 'smooth')).toEqual({ a: 1, b: 0 });
    expect(crossfaderGains(Number.NaN, 'smooth').a).toBeCloseTo(Math.SQRT1_2, 9);
  });
});

describe('faders and filter', () => {
  it('a fader at 1 is 0 dB, 0 is silent, and the taper is gentle at the top', () => {
    expect(faderGain(1)).toBe(1);
    expect(faderGain(0)).toBe(0);
    expect(faderGain(0.5)).toBeCloseTo(0.25, 9);
    expect(faderGain(2)).toBe(faderGain(1.25));
  });

  it('the filter is off in the middle, closes a low-pass to the left and opens a high-pass to the right', () => {
    const off = filterCutoffs(0, 48000);
    expect(off.lowpassHz).toBe(20000);
    expect(off.highpassHz).toBe(20);
    expect(filterCutoffs(-1, 48000).lowpassHz).toBeCloseTo(80, 6);
    expect(filterCutoffs(1, 48000).highpassHz).toBeCloseTo(6000, 6);
    expect(filterCutoffs(-0.5, 48000).lowpassHz).toBeLessThan(filterCutoffs(-0.25, 48000).lowpassHz);
    expect(filterCutoffs(0.5, 48000).highpassHz).toBeGreaterThan(filterCutoffs(0.25, 48000).highpassHz);
    // A low sample rate keeps the open low-pass under Nyquist.
    expect(filterCutoffs(0, 22050).lowpassHz).toBeLessThan(11025);
  });
});

describe('sync', () => {
  it('matches a close tempo directly', () => {
    const p = syncPlan(128, 124);
    expect(p.multiple).toBe(1);
    expect(p.pitch).toBeCloseTo(128 / 124 - 1, 12);
  });

  it('half and double time: 70 locks to 140 and 174 to 87', () => {
    expect(octaveMultiple(140, 70)).toBe(2);
    expect(syncPlan(140, 70).pitch).toBeCloseTo(0, 12);
    expect(octaveMultiple(87, 174)).toBe(0.5);
    expect(syncPlan(87, 174).pitch).toBeCloseTo(0, 12);
    expect(syncPlan(140, 72).pitch).toBeCloseTo(140 / 144 - 1, 12);
  });

  it('prefers the plain tempo when it is the nearest', () => {
    expect(octaveMultiple(120, 100)).toBe(1);
    expect(octaveMultiple(120, 120)).toBe(1);
  });

  it('beat phase and the distance between two phases wrap around', () => {
    expect(beatPhase(0.25, 0.25, 0.5)).toBe(0);
    expect(beatPhase(0.5, 0.25, 0.5)).toBeCloseTo(0.5, 12);
    expect(beatPhase(0.1, 0.25, 0.5)).toBeCloseTo(0.7, 12);
    expect(phaseDiff(0.05, 0.95)).toBeCloseTo(0.1, 12);
    expect(phaseDiff(0.95, 0.05)).toBeCloseTo(-0.1, 12);
  });

  it('aligning moves the follower to the master’s beat by the shortest way', () => {
    // Master 120 BPM on its grid; follower 100 BPM (0.6 s beats) first downbeat 0.
    const master = { grid, positionSec: 10.25 + 0.1 }; // 0.2 of a beat past a beat
    const follower = { grid: { bpm: 100, firstDownbeat: 0 }, positionSec: 30 + 0.3, multiple: 1 }; // half a beat past
    const off = alignOffsetSec(master, follower)!;
    const after = beatPhase(follower.positionSec + off, 0, 0.6);
    expect(after).toBeCloseTo(beatPhase(master.positionSec, 0.25, 0.5), 9);
    expect(Math.abs(off)).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});

describe('beat grid, loops and jumps', () => {
  it('snaps to the nearest beat or the one before', () => {
    expect(snapToGrid(1.2, grid)).toBeCloseTo(1.25, 9);
    expect(snapToGrid(1.4, grid)).toBeCloseTo(1.25, 9);
    expect(snapToGrid(1.6, grid)).toBeCloseTo(1.75, 9);
    expect(snapToGrid(1.7, grid, 1, 'floor')).toBeCloseTo(1.25, 9);
    expect(snapToGrid(1.75, grid, 1, 'floor')).toBeCloseTo(1.75, 9);
    expect(snapToGrid(3.3, null)).toBe(3.3);
  });

  it('an auto loop starts on the beat under the playhead and is the right length', () => {
    const l = autoLoopSpan(1.6, 4, grid);
    expect(l.startSec).toBeCloseTo(1.25, 9);
    expect(l.endSec).toBeCloseTo(3.25, 9);
    expect(loopBeats(l, grid)).toBeCloseTo(4, 9);
    const q = autoLoopSpan(1.6, 0.25, grid);
    expect(q.startSec).toBeCloseTo(1.5, 9); // quarter-beat steps
    expect(q.endSec - q.startSec).toBeCloseTo(0.125, 9);
  });

  it('halving and doubling keep the start and stay between 1/32 and 32 beats', () => {
    let l = autoLoopSpan(2, 4, grid);
    l = resizeLoop(l, 0.5, grid, 100);
    expect(loopBeats(l, grid)).toBeCloseTo(2, 9);
    l = resizeLoop(resizeLoop(l, 2, grid, 100), 2, grid, 100);
    expect(loopBeats(l, grid)).toBeCloseTo(8, 9);
    let big = autoLoopSpan(2, 32, grid);
    big = resizeLoop(big, 2, grid, 1000);
    expect(loopBeats(big, grid)).toBeCloseTo(32, 9);
    let tiny = autoLoopSpan(2, 0.25, grid);
    for (let i = 0; i < 10; i++) tiny = resizeLoop(tiny, 0.5, grid, 100);
    expect(loopBeats(tiny, grid)).toBeCloseTo(1 / 32, 9);
  });

  it('a hand-set loop snaps both ends and never collapses', () => {
    const l = manualLoopSpan(1.3, 3.2, grid);
    expect(l.startSec).toBeCloseTo(1.25, 9);
    expect(l.endSec).toBeCloseTo(3.25, 9);
    const short = manualLoopSpan(1.3, 1.31, grid);
    expect(short.endSec).toBeGreaterThan(short.startSec);
  });

  it('beat jumps keep the phase and stay inside the song', () => {
    expect(beatJumpTarget(10.1, 4, grid, 100)).toBeCloseTo(12.1, 9);
    expect(beatJumpTarget(10.1, -8, grid, 100)).toBeCloseTo(6.1, 9);
    expect(beatJumpTarget(1, -8, grid, 100)).toBe(0);
    expect(beatJumpTarget(99, 8, grid, 100)).toBe(100);
  });

  it('shifting a loop keeps its length and the song bounds', () => {
    const l = { startSec: 4, endSec: 6 };
    expect(shiftLoop(l, 2, 100)).toEqual({ startSec: 6, endSec: 8 });
    expect(shiftLoop(l, -10, 100)).toEqual({ startSec: 0, endSec: 2 });
    expect(shiftLoop(l, 200, 100)).toEqual({ startSec: 98, endSec: 100 });
  });

  it('a playhead past the loop end wraps back by whole loops', () => {
    const l = { startSec: 4, endSec: 6 };
    expect(wrapIntoLoop(5, l)).toBe(5);
    expect(wrapIntoLoop(6, l)).toBe(4);
    expect(wrapIntoLoop(9.5, l)).toBeCloseTo(5.5, 12);
  });
});

describe('cue (CDJ rules)', () => {
  it('playing: back to the cue point and pause', () => {
    expect(cuePressPlan({ playing: true, positionSec: 12, cuePoint: 4, grid })).toEqual({ seek: 4, pause: true });
  });

  it('paused away from the cue point: sets it here on the beat and previews', () => {
    const p = cuePressPlan({ playing: false, positionSec: 7.4, cuePoint: 0, grid });
    expect(p.setCue).toBeCloseTo(7.25, 9);
    expect(p.seek).toBeCloseTo(7.25, 9);
    expect(p.preview).toBe(true);
  });

  it('paused on the cue point: previews from it without moving it', () => {
    expect(cuePressPlan({ playing: false, positionSec: 4.004, cuePoint: 4, grid })).toEqual({ preview: true });
  });

  it('without a beat grid the cue point is exactly where the deck is', () => {
    const p = cuePressPlan({ playing: false, positionSec: 7.4, cuePoint: 0, grid: null });
    expect(p.setCue).toBe(7.4);
  });
});

describe('jog', () => {
  it('a platter at normal speed scratches at 1×, backwards at −1×', () => {
    expect(scratchRate(1 / 1.8 / 10, 0.1)).toBeCloseTo(1, 9);
    expect(scratchRate(-1 / 1.8 / 10, 0.1)).toBeCloseTo(-1, 9);
    expect(scratchRate(0, 0.016)).toBe(0);
  });

  it('limits wild flicks and tiny intervals', () => {
    expect(scratchRate(10, 0.001)).toBe(12);
    expect(scratchRate(-10, 0.001)).toBe(-12);
  });

  it('nudge bends the tempo a little and caps at 12 %', () => {
    expect(nudgeBend(1 / 1.8 / 40, 0.1)).toBeCloseTo(0.0625, 9);
    expect(nudgeBend(1 / 1.8 / 10, 0.1)).toBe(0.12);
    expect(Math.abs(nudgeBend(5, 0.1))).toBeLessThanOrEqual(0.12);
    expect(nudgeBend(-5, 0.1)).toBe(-0.12);
  });
});

describe('formatting', () => {
  it('formats time, pitch, loop lengths and the recording title', () => {
    expect(formatDeckTime(187.43)).toBe('3:07.4');
    expect(formatDeckTime(5)).toBe('0:05.0');
    expect(formatDeckTime(-2.5)).toBe('−0:02.5');
    expect(formatPitch(0.032)).toBe('+3.2%');
    expect(formatPitch(-0.005)).toBe('−0.5%');
    expect(formatPitch(0)).toBe('0.0%');
    expect(loopBeatsLabel(0.25)).toBe('1/4');
    expect(loopBeatsLabel(0.5)).toBe('1/2');
    expect(loopBeatsLabel(16)).toBe('16');
    expect(liveMixTitle(new Date(2026, 9, 16, 14, 5))).toBe('Live mix 2026-10-16 14:05');
  });

  it('picks the smallest pitch range that holds a pitch', () => {
    expect(rangeFor(0.05)).toBe(0.08);
    expect(rangeFor(-0.12)).toBe(0.16);
    expect(rangeFor(0.3)).toBe(0.5);
    expect(rangeFor(0.6)).toBeNull();
  });
});

describe('tracked beats (a song whose tempo drifts)', () => {
  // 120 BPM speeding up to 124 over three minutes: a fixed grid at the average (122) is 0.25 beat out by the middle.
  const beats = driftingBeats(120, 124, 180, 0.5);
  const tracked = deckGridOf({ bpm: 122, firstDownbeat: 0.5, beats });
  const fixed = deckGridOf({ bpm: 122, firstDownbeat: 0.5 });
  /** The distance (beats) from the nearest tracked beat. */
  const offBeat = (sec: number) => {
    const n = tracked.map!.beatAt(sec);
    return Math.abs(n - Math.round(n));
  };

  it('uses the tracked beats only when there are enough of them', () => {
    expect(tracked.map).toBeDefined();
    expect(fixed.map).toBeUndefined();
    expect(deckGridOf({ bpm: 122, firstDownbeat: 0.5, beats: beats.slice(0, 4) }).map).toBeUndefined();
    expect(deckGridOf({ bpm: 122, firstDownbeat: 0.5, beats: [] }).map).toBeUndefined();
  });

  it('snaps to the beats that are there, where the fixed grid snaps to a place with no beat', () => {
    const t = 100.2;
    expect(offBeat(snapToGrid(t, tracked))).toBeLessThan(1e-9);
    expect(offBeat(snapToGrid(t, fixed))).toBeGreaterThan(0.1);
    expect(offBeat(hotCuePosition(t, tracked))).toBeLessThan(1e-9);
    // Bars: every 4 beats from the first downbeat.
    const bar = snapToGrid(t, tracked, 4);
    expect(tracked.map!.beatAt(bar) % 4).toBeCloseTo(0, 9);
  });

  it('loops start on a beat and last the beats they say, as the beats really are', () => {
    const l = autoLoopSpan(100.3, 4, tracked);
    expect(offBeat(l.startSec)).toBeLessThan(1e-9);
    expect(offBeat(l.endSec)).toBeLessThan(1e-9);
    expect(loopBeats(l, tracked)).toBeCloseTo(4, 9);
    // Four beats around 100 s at ~122.2 BPM: 1.96 s, not the fixed grid's 1.967.
    expect(l.endSec - l.startSec).toBeCloseTo(4 * (60 / 122.2), 1);
    const half = resizeLoop(l, 0.5, tracked, 300);
    expect(loopBeats(half, tracked)).toBeCloseTo(2, 9);
    expect(half.startSec).toBe(l.startSec);
    const hand = manualLoopSpan(100.3, 103.9, tracked);
    // Hand-set loops snap to quarter beats.
    for (const t of [hand.startSec, hand.endSec]) {
      const q = tracked.map!.beatAt(t) * 4;
      expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-9);
    }
  });

  it('beat jumps land the same number of beats away, keeping the phase', () => {
    const from = 100.123;
    const to = beatJumpTarget(from, 16, tracked, 300);
    expect(tracked.map!.beatAt(to) - tracked.map!.beatAt(from)).toBeCloseTo(16, 9);
    const back = beatJumpTarget(to, -16, tracked, 300);
    expect(back).toBeCloseTo(from, 9);
    // Near the start the jump stops at the song's start, not before it.
    expect(beatJumpTarget(2, -32, tracked, 300)).toBe(0);
  });

  it('without tracked beats nothing changes', () => {
    expect(snapToGrid(1.2, grid)).toBeCloseTo(1.25, 9);
    expect(autoLoopSpan(1.6, 4, fixed).endSec - autoLoopSpan(1.6, 4, fixed).startSec).toBeCloseTo(4 * (60 / 122), 9);
  });
});
