import { describe, expect, it } from 'vitest';
import { TruePeak } from '@agstudio/sdk/worklet';
import { runEffect, type TestSignal } from '@agstudio/sdk/testing';
import { LimiterKernel } from './kernel';
import { latencyFrames, limiterParams } from './params';

const SR = 48000;
const D = latencyFrames(SR);
const db = (x: number) => 20 * Math.log10(x);
const gain = (dbv: number) => Math.pow(10, dbv / 20);

/**
 * Largest true peak of a signal, measured with an independent detector (up to the last sample:
 * cutting a render off mid-waveform would make a reconstruction overshoot of its own).
 */
function truePeak(x: Float32Array): number {
  const tp = new TruePeak();
  let peak = 0;
  for (const v of x) peak = Math.max(peak, tp.process(v));
  return peak;
}

const samplePeak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Deterministic test material that is hard to limit. */
function signals(): Record<string, TestSignal> {
  let s = 99;
  const noise = new Float32Array(SR).map(() => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  });
  const bursts = new Float32Array(SR).map((_, i) => (i % 4800 < 300 ? Math.sin(i * 0.9) * (1 + (i % 7) / 3) : 0));
  return {
    noise: (i, c) => noise[(i + c * 977) % SR] as number,
    'quarter-rate sine at 45°': (i) => Math.sin((Math.PI / 2) * i + Math.PI / 4),
    'sine 19 kHz': (i) => Math.sin((2 * Math.PI * 19000 * i) / SR),
    'sine 60 Hz': (i, c) => Math.sin((2 * Math.PI * 60 * i) / SR + c),
    square: (i) => (Math.floor(i / 37) % 2 ? 1 : -1),
    'impulse train': (i) => (i % 1000 === 0 ? 1 : i % 1000 === 1 ? -1 : 0),
    bursts: (i) => bursts[i] as number,
  };
}

describe('LimiterKernel', () => {
  it('reports a whole-frame latency and delays quiet audio by exactly that, untouched', () => {
    expect(D).toBe(240 + 14);
    expect(latencyFrames(44100)).toBe(Math.round(44100 * 0.005) + 14);
    const x: TestSignal = (i, c) => 0.3 * Math.sin(i * 0.01 + c) + (i === 500 ? 0.4 : 0);
    const [l, r] = runEffect(LimiterKernel, limiterParams, x, 4000, { params: { ceiling: -1 } });
    for (let i = 0; i < D; i++) expect(l[i]).toBe(0);
    for (let i = D; i < 4000; i++) {
      expect(l[i]).toBe(Math.fround(x(i - D, 0)));
      expect(r[i]).toBe(Math.fround(x(i - D, 1)));
    }
  });

  it('never lets a sample past the ceiling, whatever goes in', () => {
    for (const [name, x] of Object.entries(signals())) {
      for (const ceiling of [-1, -6]) {
        for (const release of [1, 80, 1000]) {
          const [l, r] = runEffect(LimiterKernel, limiterParams, x, SR / 2, {
            params: { input: 24, ceiling, release, truePeak: false },
          });
          const peak = Math.max(samplePeak(l), samplePeak(r));
          expect(peak, `${name} ${ceiling} dB ${release} ms`).toBeLessThanOrEqual(gain(ceiling));
          expect(peak, name).toBeGreaterThan(gain(ceiling) * 0.9);
        }
      }
    }
  });

  it('with True peak on, the true peak stays under the ceiling too', () => {
    for (const [name, x] of Object.entries(signals())) {
      for (const input of [0, 12, 24]) {
        const [l, r] = runEffect(LimiterKernel, limiterParams, (i, c) => 0.9 * x(i, c), SR / 2, {
          params: { input, ceiling: -1, release: 50, truePeak: true },
        });
        const peak = Math.max(truePeak(l), truePeak(r));
        expect(peak, `${name} +${input} dB`).toBeLessThanOrEqual(gain(-1));
      }
    }
  });

  it('sample-peak mode can let true peaks through; true-peak mode catches them', () => {
    // A quarter-rate sine sampled at ±45°: samples at 0.707, true peak at 1.
    const x: TestSignal = (i) => 0.95 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    const run = (truePeakOn: boolean) =>
      runEffect(LimiterKernel, limiterParams, x, SR / 4, { params: { ceiling: -3, truePeak: truePeakOn } })[0];
    const sampleMode = run(false);
    expect(samplePeak(sampleMode)).toBeLessThanOrEqual(gain(-3));
    expect(db(truePeak(sampleMode))).toBeGreaterThan(-2);
    expect(truePeak(run(true))).toBeLessThanOrEqual(gain(-3));
  });

  it('recovers over the release time once a loud passage ends', () => {
    const x: TestSignal = (i) => (i < SR / 4 ? 1 : 0.1) * Math.sin((2 * Math.PI * 200 * i) / SR);
    const [l] = runEffect(LimiterKernel, limiterParams, x, SR, {
      params: { input: 12, ceiling: -6, release: 100 },
    });
    // Loud: limited to the ceiling. Quiet (−20 dB + 12 dB in, under the ceiling): back to full gain.
    expect(samplePeak(l.subarray(SR / 8, SR / 4))).toBeCloseTo(gain(-6), 2);
    const level = (from: number) => samplePeak(l.subarray(from, from + 480)) / (0.1 * gain(12));
    expect(level(SR / 4 + D + 4800 + 480)).toBeLessThan(0.9); // ~100 ms in: still recovering
    expect(level(SR - 2000)).toBeGreaterThan(0.99);
  });
});
