import { describe, expect, it } from 'vitest';
import { constantTempo } from '../time/ppq';
import { audibleTake, planTakes, trimToTakes, type CaptureAnchor } from './takes';

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
  it('a punch range cuts the take to it, whether or not there is a loop', () => {
    // Playback from the start (after a 1 s count-in at c0 = 0), recording over bars 2–3 only.
    const sim = simulate({ startTick: 0, t0: 1, c0: 0, rt: 0.03, seconds: 8 });
    const punch = { start: 3840, end: 11520 };
    const [take, ...rest] = planTakes({ ...sim, sampleRate: SR, tempo, loop: null, startTick: 0, punch });
    expect(rest).toEqual([]);
    expect([take!.start, take!.length]).toEqual([3840, 7680]);
    // Tick 3840 is heard 2 s after playback began (t0 = 1 s: context time 3 s) and reaches the recorder 30 ms later.
    expect(take!.offsetSec).toBeCloseTo(3 + 0.03, 6);
    // Played from inside the range: the take starts where playback did.
    const sim2 = simulate({ startTick: 5760, t0: 1, c0: 0.5, rt: 0.03, seconds: 6 });
    const [inside] = planTakes({ ...sim2, sampleRate: SR, tempo, loop: null, startTick: 5760, punch });
    expect([inside!.start, inside!.length]).toEqual([5760, 11520 - 5760]);
    // A punch range that playback never reached (stopped first) leaves nothing.
    const sim3 = simulate({ startTick: 0, t0: 1, c0: 0, rt: 0.03, seconds: 1.5 });
    expect(planTakes({ ...sim3, sampleRate: SR, tempo, loop: null, startTick: 0, punch })).toEqual([]);
  });

  it('with a loop and a punch range, each pass is cut to the punch and complete means it covers the overlap', () => {
    const loop = { start: 0, end: 7680 };
    const punch = { start: 1920, end: 5760 };
    const sim = simulate({ startTick: 0, t0: 1, c0: 1, rt: 0.02, seconds: 8.2, loop });
    const takes = planTakes({ ...sim, sampleRate: SR, tempo, loop, startTick: 0, punch });
    expect(takes.map((t) => [t.pass, t.start, t.length, t.complete])).toEqual([
      [0, 1920, 3840, true],
      [1, 1920, 3840, true],
    ]);
  });

  it('trims a punch recording to the takes with a handle each side', () => {
    const takes = planTakes({
      ...simulate({ startTick: 0, t0: 1, c0: 0, rt: 0, seconds: 8 }),
      sampleRate: SR,
      tempo,
      loop: null,
      startTick: 0,
      punch: { start: 7680, end: 11520 },
    });
    const kept = trimToTakes(takes, tempo, SR, 8 * SR, 0.5);
    // The punch is 4–6 s heard, 5–7 s captured: keep 4.5–7.5 s.
    expect(kept.from / SR).toBeCloseTo(4.5, 6);
    expect(kept.to / SR).toBeCloseTo(7.5, 6);
    // The take's trim is 0.5 s into what is kept: the same audio, found at the same place.
    expect(kept.takes[0]!.offsetSec).toBeCloseTo(0.5, 6);
    expect(trimToTakes([], tempo, SR, 100)).toEqual({ from: 0, to: 100, takes: [] });
  });
});
