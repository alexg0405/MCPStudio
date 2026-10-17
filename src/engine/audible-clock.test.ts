import { describe, expect, it } from 'vitest';
import { AudibleClock, CLOCK_RESYNC } from './audible-clock';

/** A raw estimate like Chrome's: timestamps every 21 ms (1024 frames), each a few ms early or late, carried on by the wall clock. */
function rawAt(nowMs: number, seed: number): number {
  const period = 1024 / 48000; // s
  const nowS = nowMs / 1000;
  const k = Math.floor(nowS / period);
  // The callback's performanceTime wobbles by up to ±4 ms around the true one.
  const wobble = (((Math.sin((k + seed) * 12.9898) * 43758.5453) % 1) - 0.5) * 0.008;
  const perfTime = k * period + wobble;
  const contextTime = k * period; // the frames rendered so far
  return contextTime + Math.min(0.1, Math.max(0, nowS - perfTime));
}

/** Per-frame advance of the time, relative to the frame's length (1 = smooth). */
function ratios(times: number[], frameMs: number): number[] {
  return times.slice(1).map((t, i) => (t - times[i]!) / (frameMs / 1000));
}

describe('AudibleClock', () => {
  it('moves evenly although the raw timestamps jump by a few ms every audio callback', () => {
    const frame = 1000 / 60;
    const raw: number[] = [];
    const smooth: number[] = [];
    const c = new AudibleClock();
    for (let i = 0; i < 600; i++) {
      const now = 2000 + i * frame;
      raw.push(rawAt(now, 3));
      smooth.push(c.step(raw[i]!, now));
    }
    const sd = (r: number[]) => {
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
    };
    const rawR = ratios(raw, frame).slice(60);
    const smoothR = ratios(smooth, frame).slice(60);
    // The raw estimate stalls and leaps; the smoothed one advances by nearly one frame every frame.
    expect(sd(rawR)).toBeGreaterThan(0.1);
    expect(sd(smoothR)).toBeLessThan(0.05);
    expect(Math.min(...smoothR)).toBeGreaterThan(0.8);
    expect(Math.max(...smoothR)).toBeLessThan(1.2);
    // And it stays on time: within a few ms of the true time (the raw estimate itself wobbles by ±4 ms).
    const trueNow = (2000 + 599 * frame) / 1000;
    expect(Math.abs(smooth.at(-1)! - trueNow)).toBeLessThan(0.006);
  });

  it('jumps to a seek at once, and never goes back', () => {
    const c = new AudibleClock();
    expect(c.step(1, 0)).toBe(1);
    expect(c.step(1.016, 16)).toBeCloseTo(1.016, 6);
    // A seek forward (or a new song position): straight there.
    expect(c.step(10, 32)).toBe(10);
    // A raw estimate that jumped back by more than the resync limit (a stall caught up badly) holds instead.
    expect(c.step(10 - CLOCK_RESYNC * 2, 48)).toBe(10);
  });
});
