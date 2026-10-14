import { describe, expect, it } from 'vitest';
import { runEffect, type TestSignal } from '@agstudio/sdk/testing';
import { StereoKernel } from './kernel';
import { stereoParams } from './params';

const SR = 48000;
const stereo: TestSignal = (i, c) =>
  0.4 * Math.sin((2 * Math.PI * 300 * i) / SR) + (c ? -0.2 : 0.2) * Math.sin((2 * Math.PI * 1700 * i) / SR);
const rms = (a: Float32Array, from = 0) =>
  Math.sqrt(a.subarray(from).reduce((s, v) => s + v * v, 0) / (a.length - from));
const run = (params: Record<string, number | string>, x: TestSignal = stereo, frames = SR / 2) =>
  runEffect(StereoKernel, stereoParams, x, frames, { params });

describe('StereoKernel', () => {
  it('returns the input unchanged at its defaults', () => {
    const [l, r] = run({});
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(Math.fround(stereo(i, 0)));
      expect(r[i]).toBe(Math.fround(stereo(i, 1)));
    }
  });

  it('width scales the side: 0% is mono, 200% doubles the difference', () => {
    const side = (out: Float32Array[]) =>
      rms(
        Float32Array.from(out[0]!, (v, i) => (v - out[1]![i]!) / 2),
        1000,
      );
    const mid = (out: Float32Array[]) =>
      rms(
        Float32Array.from(out[0]!, (v, i) => (v + out[1]![i]!) / 2),
        1000,
      );
    const ref = run({});
    expect(side(run({ width: 0 }))).toBeLessThan(1e-7);
    expect(side(run({ width: 2 })) / side(ref)).toBeCloseTo(2, 4);
    expect(mid(run({ width: 2 })) / mid(ref)).toBeCloseTo(1, 4);
  });

  it('mono bass removes the stereo difference under the crossover and keeps the rest', () => {
    const low: TestSignal = (i, c) => (c ? -0.3 : 0.3) * Math.sin((2 * Math.PI * 50 * i) / SR);
    const high: TestSignal = (i, c) => (c ? -0.3 : 0.3) * Math.sin((2 * Math.PI * 3000 * i) / SR);
    const [ll, lr] = run({ monoBelow: 200 }, low, SR);
    const [hl] = run({ monoBelow: 200 }, high, SR);
    // 50 Hz is two octaves under 200 Hz: the out-of-phase bass is nearly gone (−48 dB).
    expect(rms(ll, SR / 2) / 0.212).toBeLessThan(0.01);
    expect(rms(lr, SR / 2) / 0.212).toBeLessThan(0.01);
    expect(rms(hl, SR / 2) / (0.3 * Math.SQRT1_2)).toBeCloseTo(1, 2);
    // In-phase (mono) bass passes at full level.
    const [ml] = run({ monoBelow: 200 }, (i) => 0.3 * Math.sin((2 * Math.PI * 50 * i) / SR), SR);
    expect(rms(ml, SR / 2) / (0.3 * Math.SQRT1_2)).toBeCloseTo(1, 3);
  });

  it('the Haas widener delays the right side; balance and phase flip do what they say', () => {
    const impulse: TestSignal = (i) => (i === 100 ? 1 : 0);
    const [l, r] = run({ haas: 10 }, impulse, 2000);
    expect(l[100]).toBe(1);
    expect(r.indexOf(Math.max(...r))).toBe(100 + 480);
    const [bl, br] = run({ balance: 0.5 });
    expect(rms(bl) / rms(run({})[0]!)).toBeCloseTo(0.5, 5);
    expect(rms(br) / rms(run({})[1]!)).toBeCloseTo(1, 5);
    const [fl, fr] = run({ flip: 'left' });
    expect(fl[1234]).toBeCloseTo(-stereo(1234, 0), 6);
    expect(fr[1234]).toBeCloseTo(stereo(1234, 1), 6);
  });
});
