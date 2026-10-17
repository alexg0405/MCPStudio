import { describe, expect, it } from 'vitest';
import { rms, runEffect, type TestSignal } from '@agstudio/sdk/testing';
import deEsser from './index';
import { DeEsserKernel, deEssReduction } from './kernel';
import { deEsserParams } from './params';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);
const sine = (hz: number, amp: number, phase = 0): TestSignal => (i) => amp * Math.sin((2 * Math.PI * hz * i) / SR + phase);
const level = (x: Float32Array, from: number, to: number) => db(rms(x, from, to));

/** Amplitude of the component at `hz` over frames [from, to) (a Goertzel-style single-bin DFT). */
function component(x: Float32Array, hz: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const a = (2 * Math.PI * hz * i) / SR;
    re += (x[i] as number) * Math.cos(a);
    im -= (x[i] as number) * Math.sin(a);
  }
  return (2 / (to - from)) * Math.hypot(re, im);
}

/** Deterministic white noise in [-1, 1). */
function noiseGen(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** A "sibilant": 7 kHz at -12 dBFS from 0.1 s to 0.3 s, silence around it. */
const BURST_FROM = 0.1 * SR;
const BURST_TO = 0.3 * SR;
const burst: TestSignal = (i, c) => (i >= BURST_FROM && i < BURST_TO ? sine(7000, 0.25, c * 0.4)(i, c) : 0);

describe('deEssReduction', () => {
  it('is zero under the threshold, follows the ratio over it and stops at the range', () => {
    expect(deEssReduction(-40, -28, 4, 10)).toBe(0);
    expect(deEssReduction(-18, -28, 4, 20)).toBeCloseTo(7.5, 6); // 10 dB over at 4:1 turns 7.5 dB down
    expect(deEssReduction(0, -28, 4, 10)).toBe(10);
    expect(deEssReduction(-28, -28, 4, 10)).toBeCloseTo(0.375, 6); // at the threshold: half way into the soft knee
  });
});

describe('DeEsserKernel', () => {
  it('turns a 7 kHz sibilant burst down by at least 6 dB (10 dB at the defaults)', () => {
    const [l, r] = runEffect(DeEsserKernel, deEsserParams, burst, SR / 2);
    const input = Float32Array.from({ length: SR / 2 }, (_, i) => burst(i, 0));
    // The steady part of the burst, after the attack has settled.
    const from = 0.2 * SR;
    const to = 0.29 * SR;
    const reduction = level(input, from, to) - level(l, from, to);
    expect(reduction).toBeGreaterThanOrEqual(6);
    expect(reduction).toBeLessThan(11);
    expect(level(Float32Array.from(r), from, to)).toBeLessThan(level(input, from, to) - 6);
  });

  it('catches the start of the “s” quickly and lets go after it', () => {
    const [l] = runEffect(DeEsserKernel, deEsserParams, burst, SR / 2, { params: { attack: 0.3, release: 40 } });
    // Within 5 ms of the start the burst is already well down.
    const early = rms(l, BURST_FROM + 0.004 * SR, BURST_FROM + 0.006 * SR);
    expect(db(early / (0.25 / Math.SQRT2))).toBeLessThan(-4);
    // 400 ms after it ends the band is back to full: a quiet 7 kHz blip plays at its own level.
    const blip: TestSignal = (i, c) => (i >= 0.45 * SR ? sine(7000, 0.01)(i, c) : burst(i, c));
    const [m] = runEffect(DeEsserKernel, deEsserParams, blip, SR / 2);
    expect(level(m, 0.46 * SR, 0.49 * SR)).toBeCloseTo(level(Float32Array.from({ length: SR / 2 }, (_, i) => blip(i, 0)), 0.46 * SR, 0.49 * SR), 0);
  });

  it('leaves a 1 kHz tone within 0.2 dB, at any level and at every preset', () => {
    for (const amp of [0.05, 0.25, 0.7, 0.95]) {
      for (const preset of [{ name: 'defaults', params: {} }, ...(deEsser.presets ?? [])]) {
        const x = sine(1000, amp);
        const [l] = runEffect(DeEsserKernel, deEsserParams, x, SR / 2, { params: preset.params as never });
        const input = Float32Array.from({ length: SR / 2 }, (_, i) => x(i, 0));
        const diff = Math.abs(level(l, 0.1 * SR, 0.5 * SR) - level(input, 0.1 * SR, 0.5 * SR));
        expect(diff, `${preset.name} at ${amp}`).toBeLessThan(0.2);
      }
    }
  });

  it('is the input itself while nothing is over the threshold', () => {
    const x = sine(1000, 0.25);
    const [l, r] = runEffect(DeEsserKernel, deEsserParams, x, SR / 4);
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(Math.fround(x(i, 0)));
      expect(r[i]).toBe(Math.fround(x(i, 1)));
    }
  });

  it('split mode leaves the rest of a voice alone while an “s” plays; wideband turns all of it down', () => {
    // A 1 kHz vowel under a 7 kHz hiss.
    const mixed: TestSignal = (i, c) => sine(1000, 0.25)(i, c) + burst(i, c);
    const measure = (mode: 'split' | 'wide') => {
      const [l] = runEffect(DeEsserKernel, deEsserParams, mixed, SR / 2, { params: { mode } });
      return {
        vowel: db(component(l, 1000, 0.2 * SR, 0.29 * SR) / 0.25),
        hiss: db(component(l, 7000, 0.2 * SR, 0.29 * SR) / 0.25),
      };
    };
    const split = measure('split');
    expect(Math.abs(split.vowel)).toBeLessThan(0.5);
    expect(split.hiss).toBeLessThan(-6);
    const wide = measure('wide');
    expect(wide.vowel).toBeLessThan(-6);
    expect(wide.hiss).toBeLessThan(-6);
  });

  it('Listen plays only the watched band', () => {
    const mixed: TestSignal = (i, c) => sine(200, 0.3)(i, c) + sine(7000, 0.1)(i, c);
    const [l] = runEffect(DeEsserKernel, deEsserParams, mixed, SR / 2, { params: { listen: true } });
    expect(db(component(l, 200, 0.2 * SR, 0.4 * SR) / 0.3)).toBeLessThan(-30);
    expect(db(component(l, 7000, 0.2 * SR, 0.4 * SR) / 0.1)).toBeGreaterThan(-1);
  });

  it('moves the band with the Frequency knob', () => {
    const at = (frequency: number) => {
      const [l] = runEffect(DeEsserKernel, deEsserParams, sine(4000, 0.3), SR / 2, { params: { frequency, listen: true } });
      return component(l, 4000, 0.2 * SR, 0.4 * SR) / 0.3;
    };
    expect(at(4000)).toBeGreaterThan(0.95);
    expect(at(10000)).toBeLessThan(0.15);
  });

  it('shows the reduction in its meter and returns it to 0 after the “s”', () => {
    const readings: number[] = [];
    runEffect(DeEsserKernel, deEsserParams, burst, SR, {
      onPost: (msg) => readings.push((msg as { readings: { gr: number } }).readings.gr),
    });
    expect(Math.max(...readings)).toBeGreaterThan(8);
    expect(Math.max(...readings)).toBeLessThanOrEqual(10.01);
    expect(readings[readings.length - 1]).toBeLessThan(0.5);
    expect(readings[0]).toBe(0);
  });

  it('is deterministic and finite on noise at the extremes', () => {
    const make = () => {
      const rnd = noiseGen(5);
      return Float32Array.from({ length: SR / 2 }, () => 0.8 * rnd());
    };
    const a = make();
    const run = (params: Record<string, number | boolean | string>) => runEffect(DeEsserKernel, deEsserParams, (i) => a[i] as number, SR / 2, { params: params as never });
    const x = run({ threshold: -60, range: 24, ratio: 20, attack: 0.05, release: 5, q: 6, frequency: 12000 });
    const y = run({ threshold: -60, range: 24, ratio: 20, attack: 0.05, release: 5, q: 6, frequency: 12000 });
    expect(x[0].every(Number.isFinite)).toBe(true);
    expect(Buffer.from(x[0].buffer).equals(Buffer.from(y[0].buffer))).toBe(true);
    expect(Buffer.from(x[1].buffer).equals(Buffer.from(y[1].buffer))).toBe(true);
  });
});
