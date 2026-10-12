import { describe, expect, it } from 'vitest';
import { SafetyLimiterKernel } from './limiter-kernel';

const host = { sampleRate: 48000, state: undefined, post: () => {}, rand: () => 0 };
const params = { ceiling: new Float32Array([-0.3]) };

function run(k: SafetyLimiterKernel, signal: (i: number) => number, frames: number) {
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  for (let start = 0; start < frames; start += 128) {
    const n = Math.min(128, frames - start);
    const inL = Float32Array.from({ length: n }, (_, i) => signal(start + i));
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    k.process([inL, inL], [oL, oR], n, params);
    outL.set(oL, start);
    outR.set(oR, start);
  }
  return outL;
}

describe('SafetyLimiterKernel', () => {
  const ceiling = Math.pow(10, -0.3 / 20);

  it('never exceeds the ceiling on a hot signal', () => {
    const k = new SafetyLimiterKernel(host);
    const out = run(k, (i) => 3 * Math.sin((2 * Math.PI * 100 * i) / 48000), 48000);
    let peak = 0;
    for (const x of out) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-6);
    // It limits rather than silences.
    expect(peak).toBeGreaterThan(ceiling * 0.9);
  });

  it('is transparent below the ceiling (apart from its look-ahead delay)', () => {
    const k = new SafetyLimiterKernel(host);
    const sig = (i: number) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    const out = run(k, sig, 4800);
    const delay = Math.round(0.0013 * 48000);
    for (let i = delay + 10; i < 4800; i += 97) expect(out[i]).toBeCloseTo(sig(i - delay), 5);
  });
});
