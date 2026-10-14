import { describe, expect, it } from 'vitest';
import { Adsr } from './adsr';
import { DelayLine } from './delay-line';
import { Lfo } from './lfo';
import { BlepOscillator, polyBlep } from './polyblep';

const SR = 48000;

describe('Adsr', () => {
  it('ramps up, decays to the sustain level, holds, then releases to silence', () => {
    const env = new Adsr(SR, 0.01, 0.1, 0.5, 0.2);
    env.start();
    let v = 0;
    for (let i = 0; i < 0.01 * SR; i++) v = env.next();
    expect(v).toBeCloseTo(1, 3);
    for (let i = 0; i < 0.1 * SR; i++) v = env.next();
    // −60 dB of the way to the sustain level at the decay time.
    expect(v).toBeCloseTo(0.5 + 0.5 / 1000, 3);
    for (let i = 0; i < SR; i++) v = env.next();
    expect(v).toBe(0.5);
    env.release();
    expect(env.held).toBe(false);
    for (let i = 0; i < 0.2 * SR; i++) v = env.next();
    expect(v).toBeCloseTo(0.5 / 1000, 4);
    for (let i = 0; i < SR && env.active; i++) env.next();
    expect(env.active).toBe(false);
    expect(env.value).toBe(0);
  });

  it('retriggers from where it is, without a jump', () => {
    const env = new Adsr(SR, 0.01, 0.1, 0.5, 0.5);
    env.start();
    for (let i = 0; i < 2000; i++) env.next();
    env.release();
    for (let i = 0; i < 1000; i++) env.next();
    const before = env.value;
    env.start();
    expect(Math.abs(env.next() - before)).toBeLessThan(0.01);
  });
});

describe('BlepOscillator', () => {
  const run = (wave: BlepOscillator['wave'], freq: number, n = SR) => {
    const osc = new BlepOscillator(SR);
    osc.wave = wave;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = osc.next(freq);
    return out;
  };

  it('makes each wave in −1…1 with no DC', () => {
    for (const wave of ['sine', 'saw', 'square', 'pulse', 'triangle'] as const) {
      const out = run(wave, 220);
      let peak = 0;
      let sum = 0;
      for (const x of out) {
        peak = Math.max(peak, Math.abs(x));
        sum += x;
      }
      expect(peak, wave).toBeLessThan(1.12);
      expect(peak, wave).toBeGreaterThan(0.9);
      if (wave !== 'pulse') expect(Math.abs(sum / out.length), wave).toBeLessThan(0.01);
    }
  });

  it('smooths the saw’s jump (that is what removes the aliasing)', () => {
    const naive = (t: number) => 2 * t - 1;
    expect(polyBlep(0.5, 0.01)).toBe(0);
    const out = run('saw', 1000, 200);
    // Without correction the wrap jumps by ~2 in one sample; with it, the step is spread out.
    let worst = 0;
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!));
    expect(worst).toBeLessThan(1.6);
    expect(naive(0.999) - naive(0)).toBeCloseTo(1.998, 3);
  });
});

describe('DelayLine', () => {
  it('reads back what was written, at whole and fractional delays', () => {
    const d = new DelayLine(100);
    for (let i = 0; i < 200; i++) d.write(i);
    expect(d.read(0)).toBe(199);
    expect(d.read(10)).toBe(189);
    expect(d.read(10.25)).toBeCloseTo(188.75, 5);
    // A straight line is reproduced exactly by the cubic too.
    expect(d.readCubic(10.25)).toBeCloseTo(188.75, 4);
    expect(d.maxDelay).toBeGreaterThanOrEqual(100);
    d.clear();
    expect(d.read(5)).toBe(0);
  });
});

describe('Lfo', () => {
  it('runs freely at a rate', () => {
    const lfo = new Lfo(SR);
    lfo.shape = 'square';
    const values = Array.from({ length: SR }, () => lfo.next(2));
    // 2 Hz square: high for the first quarter second.
    expect(values[SR / 8]).toBe(1);
    expect(values[(3 * SR) / 8]).toBe(-1);
    expect(values[(5 * SR) / 8]).toBe(1);
  });

  it('locks to the song position, and random shapes repeat on every playback', () => {
    const lfo = new Lfo(SR, 7);
    expect(lfo.atBeat(0.5, 2)).toBeCloseTo(1, 9); // a quarter of a 2-beat sine cycle
    expect(lfo.atBeat(2.5, 2)).toBeCloseTo(1, 9);
    lfo.shape = 'random';
    const a = [0, 1, 2, 3].map((b) => lfo.atBeat(b + 0.5, 1));
    // Sample and hold: one value for the whole cycle.
    expect(lfo.valueAt(0, 3)).toBe(lfo.valueAt(0.9, 3));
    expect([0, 1, 2, 3].map((b) => lfo.atBeat(b + 0.5, 1))).toEqual(a);
    expect(new Set(a).size).toBe(4);
    for (const v of a) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    lfo.shape = 'smooth';
    // Continuous across a cycle boundary.
    expect(Math.abs(lfo.atBeat(0.9999, 1) - lfo.atBeat(1.0001, 1))).toBeLessThan(0.01);
  });
});
