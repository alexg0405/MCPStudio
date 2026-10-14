import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { FlangerKernel } from './kernel';
import { flangerParams } from './params';

const SR = 48000;
type Params = TestParams<typeof flangerParams>;
const sine =
  (freq: number, amp = 0.5) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * freq * i) / SR);
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);

/** Steady-state level (dB re. input) of a sine through the flanger. */
function level(freq: number, params: Params): number {
  const [l] = runEffect(FlangerKernel, flangerParams, sine(freq), SR / 2, { params });
  let sum = 0;
  for (let i = SR / 4; i < SR / 2; i++) sum += (l[i] as number) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / (SR / 4)) / (0.5 * Math.SQRT1_2));
}

describe('FlangerKernel', () => {
  it('passes the input untouched at 0% mix', () => {
    const x: TestSignal = (i, c) => Math.sin(i * 0.01 + c) * 0.5;
    const [l, r] = runEffect(FlangerKernel, flangerParams, x, 4096, { params: { mix: 0 } });
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(Math.fround(x(i, 0)));
      expect(r[i]).toBe(Math.fround(x(i, 1)));
    }
  });

  it('with no sweep it is a comb: notches at odd multiples of 1 / (2 · delay)', () => {
    // 1 ms delay: notches at 500, 1500, 2500 Hz; peaks at 1000, 2000 Hz.
    const still: Params = { depth: 0, delay: 1, feedback: 0, mix: 0.5 };
    for (const f of [500, 1500, 2500]) expect(level(f, still), `${f} Hz`).toBeLessThan(-35);
    for (const f of [1000, 2000]) expect(Math.abs(level(f, still)), `${f} Hz`).toBeLessThan(0.1);
    // Positive feedback makes the peaks ring; negative feedback moves them onto the old notches.
    expect(level(1000, { ...still, feedback: 0.8 })).toBeGreaterThan(3);
    const hollow: Params = { ...still, feedback: -0.8 };
    expect(level(500, hollow) - level(1000, hollow)).toBeGreaterThan(3);
  });

  it('stays stable and sane at the feedback extremes', () => {
    for (const feedback of [-0.95, 0.95]) {
      const [l] = runEffect(FlangerKernel, flangerParams, sine(300), SR, { params: { feedback, depth: 1, mix: 1 } });
      expect(l.every(Number.isFinite)).toBe(true);
      expect(Math.max(...Array.from(l, Math.abs))).toBeLessThan(15);
    }
  });

  it('a synced sweep follows the song position and keeps moving when stopped', () => {
    const run = (beat: number, sync: string, playing = true) =>
      runEffect(FlangerKernel, flangerParams, sine(440), SR / 2, {
        params: { sync, depth: 1, mix: 0.5 },
        transport: { playing, bpm: 120, beat },
      })[0];
    expect(maxDiff(run(0, '1/4'), run(1, '1/4'))).toBeLessThan(1e-6);
    expect(maxDiff(run(0, '1/4'), run(0.25, '1/4'))).toBeGreaterThan(0.01);
    expect(maxDiff(run(0, 'off'), run(0.25, 'off'))).toBeLessThan(1e-6);
    const still = runEffect(FlangerKernel, flangerParams, sine(440), SR / 2, {
      params: { sync: '1/4', depth: 0, mix: 0.5 },
      transport: { playing: false, bpm: 120 },
    })[0];
    expect(maxDiff(run(0, '1/4', false), still)).toBeGreaterThan(0.01);
  });
});
