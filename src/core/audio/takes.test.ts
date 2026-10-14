import { describe, expect, it } from 'vitest';
import { constantTempo } from '../time/ppq';
import { audibleTake, planTakes, type CaptureAnchor } from './takes';

const SR = 48000;
const TPS = 1920; // ticks per second at 120 BPM
const tempo = constantTempo(120);

/**
 * What the recorder notes while recording: the transport starts at context time `t0` on `startTick`
 * (looping `loop`), the capture starts at `c0`, and the round trip is `rt` seconds. One anchor every
 * 50 ms of capture, like the real drain.
 */
function simulate(opts: { startTick: number; t0: number; c0: number; rt: number; seconds: number; loop?: { start: number; end: number } }) {
  const heard = (t: number): { tick: number; iter: number } => {
    const p = opts.startTick + (t - opts.t0) * TPS;
    const L = opts.loop;
    if (!L || t < opts.t0 || p < L.end) return { tick: p, iter: 0 };
    const len = L.end - L.start;
    const over = p - L.end;
    return { tick: L.start + (over % len), iter: 1 + Math.floor(over / len) };
  };
  const frames = Math.round(opts.seconds * SR);
  const anchors: CaptureAnchor[] = [];
  for (let f = 0; f <= frames; f += 2400) anchors.push({ frame: f, ...heard(opts.c0 + f / SR - opts.rt) });
  return { anchors, frames };
}

describe('recorded takes', () => {
  it('places a take at the record start, trimmed past the count-in, compensating the round trip', () => {
    // Playback (after a count-in) starts at 1 s on bar 2; the capture started at 0.5 s; 50 ms round trip.
    const sim = simulate({ startTick: 3840, t0: 1, c0: 0.5, rt: 0.05, seconds: 3 });
    const [take, ...rest] = planTakes({ ...sim, sampleRate: SR, tempo, loop: null, startTick: 3840 });
    expect(rest).toEqual([]);
    expect(take).toMatchObject({ pass: 0, start: 3840, complete: false });
    // Bar 2 was heard 1 s in, and reached the recorder 50 ms later: 0.55 s into the capture.
    expect(take!.offsetSec).toBeCloseTo(0.55, 6);
    // The last frame (3.5 s) was played along with what was heard at 3.45 s.
    expect(take!.length).toBe(Math.round(2.45 * TPS));
    // A hit played on beat 3 of bar 2 lands on it: its frame in the recording is where the clip
    // plays that tick.
    const tick = 3840 + 960 * 2;
    const arrives = (1 + (tick - 3840) / TPS + 0.05 - 0.5) * SR;
    expect((take!.offsetSec + (tick - take!.start) / TPS) * SR).toBeCloseTo(arrives, 3);
  });

  it('makes one take per loop pass (punch in and out on the loop region)', () => {
    const loop = { start: 0, end: 3840 };
    // Starting half way into the loop: a half pass, two full ones, then stopped half way again.
    const sim = simulate({ startTick: 1920, t0: 1, c0: 1, rt: 0.02, seconds: 5.5, loop });
    const takes = planTakes({ ...sim, sampleRate: SR, tempo, loop, startTick: 1920 });
    expect(takes.map((t) => [t.pass, t.start, t.length, t.complete])).toEqual([
      [0, 1920, 1920, false],
      [1, 0, 3840, true],
      [2, 0, 3840, true],
      [3, 0, Math.round((5.5 - 0.02 - 5) * TPS), false],
    ]);
    // Each pass starts where it was heard: pass 1 began 1 s after playback (+ the round trip).
    expect(takes[1]!.offsetSec).toBeCloseTo(1 + 0.02, 6);
    expect(takes[2]!.offsetSec).toBeCloseTo(3 + 0.02, 6);
    expect(audibleTake(takes)).toBe(2);
  });

  it('starts at the loop when playback starts outside it, and drops passes too short to keep', () => {
    const loop = { start: 3840, end: 7680 };
    const sim = simulate({ startTick: 3840, t0: 1, c0: 0.9, rt: 0.01, seconds: 2.15, loop });
    const takes = planTakes({ ...sim, sampleRate: SR, tempo, loop, startTick: 0 });
    expect(takes.map((t) => [t.pass, t.start, t.complete])).toEqual([[0, 3840, true]]);
    expect(audibleTake([])).toBe(-1);
  });
});
