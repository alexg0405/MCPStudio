import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PPQ, constantTempo } from './ppq';
import { sameTempo, secondsBetween, steppedTempo } from './tempo';

describe('steppedTempo', () => {
  const map = steppedTempo([
    { tick: 0, bpm: 120 },
    { tick: 3840, bpm: 60 },
    { tick: 7680, bpm: 240 },
  ]);

  it('integrates seconds across tempo steps', () => {
    const spt120 = 60 / (120 * PPQ);
    expect(map.tickToSeconds(3840)).toBeCloseTo(3840 * spt120, 12); // 2 s
    expect(map.tickToSeconds(7680)).toBeCloseTo(2 + 4, 12); // a 4/4 bar at 60 = 4 s
    expect(map.tickToSeconds(7680 + 960)).toBeCloseTo(6 + 0.25, 12);
    expect(map.bpmAt(3839)).toBe(120);
    expect(map.bpmAt(3840)).toBe(60);
    expect(map.nextChange(0)).toBe(3840);
    expect(map.nextChange(3840)).toBe(7680);
    expect(map.nextChange(8000)).toBe(Infinity);
    expect(secondsBetween(map, 3840, 7680)).toBeCloseTo(4, 12);
  });

  it('inverts tickToSeconds', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 50_000, noNaN: true }), (tick) => {
        expect(map.secondsToTick(map.tickToSeconds(tick))).toBeCloseTo(tick, 6);
      }),
    );
  });

  it('merges equal neighbours and collapses to a constant map', () => {
    const flat = steppedTempo([
      { tick: 0, bpm: 100 },
      { tick: 240, bpm: 100 },
      { tick: 480, bpm: 100 },
    ]);
    expect(flat.constant).toBe(true);
    expect(flat.nextChange(0)).toBe(Infinity);
    expect(sameTempo(flat, constantTempo(100), 10_000)).toBe(true);
    expect(sameTempo(map, constantTempo(120), 10_000)).toBe(false);
  });
});
