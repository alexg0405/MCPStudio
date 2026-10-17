import { describe, expect, it } from 'vitest';
import { BeatMap, driftingBeats } from './beat-map';

describe('BeatMap', () => {
  const beats = driftingBeats(120, 124, 180, 0.35);
  const map = new BeatMap(beats, 0.35);

  it('counts whole beats at the beats and interpolates between them', () => {
    expect(map.beatAt(beats[0]!)).toBeCloseTo(0, 12);
    expect(map.beatAt(beats[10]!)).toBeCloseTo(10, 12);
    expect(map.beatAt((beats[10]! + beats[11]!) / 2)).toBeCloseTo(10.5, 12);
    // Beat 0 is the one at the origin, whichever index it has.
    const shifted = new BeatMap(beats, beats[4]!);
    expect(shifted.beatAt(beats[4]!)).toBeCloseTo(0, 12);
    expect(shifted.beatAt(beats[9]!)).toBeCloseTo(5, 12);
    expect(shifted.beatAt(beats[0]!)).toBeCloseTo(-4, 12);
  });

  it('posAt is the inverse of beatAt, also beyond the first and last beat', () => {
    for (const p of [-3, 0.35, 12.3456, 90, 179.9, 200]) expect(map.posAt(map.beatAt(p))).toBeCloseTo(p, 9);
  });

  it('reads the tempo from the beats around the position, smoothly', () => {
    expect(60 / map.lenAt(1)).toBeCloseTo(120, 0);
    expect(60 / map.lenAt(90)).toBeCloseTo(122, 0);
    expect(60 / map.lenAt(179)).toBeCloseTo(124, 0);
    // No jump from one beat to the next.
    let worst = 0;
    for (let i = 5; i < beats.length - 5; i++) {
      const a = map.lenAt(beats[i]! - 1e-6);
      const b = map.lenAt(beats[i]! + 1e-6);
      worst = Math.max(worst, Math.abs(a - b));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('answers a steady playhead cheaply and a jump correctly, in either direction', () => {
    for (let p = 0; p < 170; p += 0.0213) expect(Math.abs(map.beatAt(p) - Math.round(map.beatAt(p)))).toBeLessThanOrEqual(0.5);
    const b = map.beatAt(150);
    expect(map.beatAt(3)).toBeLessThan(b);
    expect(map.beatAt(150)).toBeCloseTo(b, 12);
    expect(map.beatAt(0)).toBeLessThan(0.1);
  });

  it('drops beats that are not in order and needs two', () => {
    const m = new BeatMap([0, 0.5, 0.5, 0.4, 1, NaN, 1.5, 2], 0);
    expect(m.count).toBe(5);
    expect(() => new BeatMap([1], 1)).toThrow();
  });
});

describe('driftingBeats', () => {
  it('speeds up linearly from the first tempo to the second', () => {
    const b = driftingBeats(120, 124, 180);
    expect(b[0]).toBe(0);
    expect(b[1]! - b[0]!).toBeCloseTo(0.5, 3);
    expect(b[b.length - 1]! - b[b.length - 2]!).toBeCloseTo(60 / 124, 2);
    // Total beats: the average tempo (122) over 3 minutes.
    expect(b.length).toBeCloseTo(122 * 3, -1);
  });
});
