import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams } from '@agstudio/sdk/testing';
import { SaturatorKernel, saturate, softClip } from './kernel';
import { saturatorParams } from './params';

const SR = 48000;
type Params = TestParams<typeof saturatorParams>;
const sine = (freq: number, amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * freq * i) / SR);

/** Amplitude of the `freq` component of x over its second half (least-squares fit). */
function amplitude(x: Float32Array, freq: number): number {
  let c = 0;
  let s = 0;
  const from = x.length / 2;
  const n = Math.round(Math.floor(((x.length - from) * freq) / SR) * (SR / freq));
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * freq * i) / SR;
    c += (x[from + i] as number) * Math.cos(w);
    s += (x[from + i] as number) * Math.sin(w);
  }
  return (2 * Math.hypot(c, s)) / n;
}

const run = (freq: number, amp: number, params: Params) =>
  runEffect(SaturatorKernel, saturatorParams, sine(freq, amp), SR / 2, { params })[0];
const db = (x: number) => 20 * Math.log10(x);

describe('SaturatorKernel', () => {
  it('its curves are smooth, bounded and odd/asymmetric as they should be', () => {
    for (let x = -6; x <= 6; x += 0.01) expect(Math.abs(softClip(x) - Math.tanh(x))).toBeLessThan(1e-4);
    expect(saturate(0, 100)).toBe(1);
    expect(saturate(2, 3)).toBe(1);
    // Tube: unity slope at 0, clips sooner on one side than the other.
    expect(saturate(1, 1e-4) / 1e-4).toBeCloseTo(1, 3);
    expect(saturate(1, 0)).toBe(0);
    expect(Math.abs(saturate(1, 10))).not.toBeCloseTo(Math.abs(saturate(1, -10)), 1);
  });

  it('a quiet sound with no drive stays clean; drive adds harmonics', () => {
    const clean = run(500, 0.05, { drive: 0 });
    expect(db(amplitude(clean, 1500) / amplitude(clean, 500))).toBeLessThan(-60);
    for (const mode of ['tape', 'clip'] as const) {
      const hot = run(500, 0.5, { mode, drive: 24 });
      // Odd harmonics (symmetric curves): a strong 3rd, almost no 2nd.
      expect(db(amplitude(hot, 1500) / amplitude(hot, 500)), mode).toBeGreaterThan(-20);
      expect(db(amplitude(hot, 1000) / amplitude(hot, 500)), mode).toBeLessThan(-50);
    }
    const tube = run(500, 0.5, { mode: 'tube', drive: 18 });
    expect(db(amplitude(tube, 1000) / amplitude(tube, 500))).toBeGreaterThan(-25);
  });

  it('the tube curve leaves no DC offset', () => {
    const tube = run(300, 0.8, { mode: 'tube', drive: 24 });
    const tail = tube.subarray(SR / 4);
    const mean = tail.reduce((a, v) => a + v, 0) / tail.length;
    expect(Math.abs(mean)).toBeLessThan(1e-3);
  });

  it('0% mix keeps the level at every frequency (dry goes through the same filters)', () => {
    for (const freq of [50, 1000, 8000, 18000]) {
      const out = run(freq, 0.5, { drive: 30, mix: 0 });
      expect(Math.abs(db(amplitude(out, freq) / 0.5)), `${freq} Hz`).toBeLessThan(0.05);
    }
  });

  it('4× oversampling aliases less than 2×, and nothing blows up', () => {
    // An 11 kHz sine clipped hard: at 2× its 7th harmonic folds to 96 − 77 = 19 kHz.
    const two = run(11000, 0.9, { mode: 'clip', drive: 18, oversample: '2x' });
    const four = run(11000, 0.9, { mode: 'clip', drive: 18, oversample: '4x' });
    expect(db(amplitude(four, 19000))).toBeLessThan(db(amplitude(two, 19000)) - 20);
    for (const mode of ['tape', 'tube', 'clip'] as const) {
      const out = run(60, 1, { mode, drive: 36, tone: 1, output: 12 });
      expect(out.every(Number.isFinite), mode).toBe(true);
    }
  });

  it('keeps the level roughly even as the drive goes up', () => {
    const level = (drive: number) => amplitude(run(400, 0.25, { drive }), 400);
    expect(Math.abs(db(level(18) / level(0)))).toBeLessThan(6);
  });
});
