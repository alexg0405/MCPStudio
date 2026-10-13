import { describe, expect, it } from 'vitest';
import { EnvelopeFollower } from './envelope';
import { OnePole } from './one-pole';
import { Svf, type SvfType } from './svf';

const SR = 48000;
const db = (g: number) => 20 * Math.log10(g);

/** Steady-state gain of `process` for a sine at `freq` (RMS of the second half). */
function sineGain(process: (x: number) => number, freq: number, sr = SR, seconds = 0.5): number {
  const n = Math.round(sr * seconds);
  let inSum = 0;
  let outSum = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sr);
    const y = process(x);
    if (i >= n / 2) {
      inSum += x * x;
      outSum += y * y;
    }
  }
  return Math.sqrt(outSum / inSum);
}

describe('OnePole', () => {
  it('reaches 63 % of a step after its time constant and holds DC at unity', () => {
    const f = new OnePole().setTime(0.01, SR);
    let y = 0;
    for (let i = 0; i < 480; i++) y = f.process(1);
    expect(y).toBeCloseTo(1 - Math.exp(-1), 2);
    for (let i = 0; i < SR; i++) y = f.process(1);
    expect(y).toBeCloseTo(1, 9);
    expect(f.value).toBe(y);
  });

  it('is -3 dB at its cutoff (well below Nyquist), and its high-pass blocks DC', () => {
    const lp = new OnePole().setCutoff(200, SR);
    expect(db(sineGain((x) => lp.process(x), 200))).toBeCloseTo(-3, 0);
    const lp2 = new OnePole().setCutoff(200, SR);
    expect(db(sineGain((x) => lp2.process(x), 20))).toBeGreaterThan(-0.1);
    const hp = new OnePole().setCutoff(100, SR);
    let y = 1;
    for (let i = 0; i < SR; i++) y = hp.highpass(1);
    expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('follows the input exactly with time 0, flushes tiny values and resets', () => {
    const f = new OnePole().setTime(0, SR);
    expect(f.process(0.25)).toBe(0.25);
    f.setTime(0.001, SR);
    for (let i = 0; i < SR; i++) f.process(0);
    expect(f.value).toBe(0);
    f.reset(0.5);
    expect(f.value).toBe(0.5);
  });
});

describe('Svf', () => {
  const at = (type: SvfType, cutoff: number, freq: number, q = Math.SQRT1_2, gainDb = 0) => {
    const f = new Svf().set(type, cutoff, q, SR, gainDb);
    return db(sineGain((x) => f.process(x), freq));
  };

  it('low-pass: unity in the pass band, -3 dB at the cutoff (Butterworth Q), -12 dB/octave above', () => {
    expect(at('lowpass', 1000, 50)).toBeCloseTo(0, 1);
    expect(at('lowpass', 1000, 1000)).toBeCloseTo(-3.01, 1);
    const oct = at('lowpass', 1000, 4000) - at('lowpass', 1000, 8000);
    expect(oct).toBeGreaterThan(10);
    expect(oct).toBeLessThan(14);
  });

  it('high-pass and band-pass', () => {
    expect(at('highpass', 1000, 12000)).toBeCloseTo(0, 1);
    expect(at('highpass', 1000, 1000)).toBeCloseTo(-3.01, 1);
    expect(at('highpass', 1000, 60)).toBeLessThan(-40);
    expect(at('bandpass', 1000, 1000, 2)).toBeCloseTo(0, 1);
    expect(at('bandpass', 1000, 100, 2)).toBeLessThan(-20);
  });

  it('notch, all-pass, bell and shelves', () => {
    expect(at('notch', 1000, 1000, 1)).toBeLessThan(-40);
    expect(at('allpass', 1000, 300)).toBeCloseTo(0, 1);
    expect(at('allpass', 1000, 3000)).toBeCloseTo(0, 1);
    expect(at('bell', 1000, 1000, 1, 6)).toBeCloseTo(6, 1);
    expect(at('bell', 1000, 1000, 1, -9)).toBeCloseTo(-9, 1);
    expect(at('bell', 1000, 20, 1, 6)).toBeCloseTo(0, 1);
    expect(at('lowshelf', 500, 20, 0.707, 6)).toBeCloseTo(6, 1);
    expect(at('lowshelf', 500, 15000, 0.707, 6)).toBeCloseTo(0, 1);
    expect(at('highshelf', 500, 15000, 0.707, -6)).toBeCloseTo(-6, 1);
    expect(at('highshelf', 500, 20, 0.707, -6)).toBeCloseTo(0, 1);
  });

  it('keeps the core outputs for multimode use: low + band + high = input', () => {
    const f = new Svf().set('lowpass', 800, 0.5, SR);
    for (let i = 0; i < 1000; i++) {
      const x = Math.sin(i * 0.05) + (i % 97 === 0 ? 0.5 : 0);
      f.process(x);
      expect(f.low + f.band + f.high).toBeCloseTo(x, 9);
    }
  });

  it('stays stable while the cutoff sweeps every sample, and resets', () => {
    const f = new Svf();
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      f.set('lowpass', 30 + 15000 * (0.5 + 0.5 * Math.sin(i * 0.01)), 8, SR);
      const y = f.process(Math.sin(i * 0.3));
      peak = Math.max(peak, Math.abs(y));
      expect(Number.isFinite(y)).toBe(true);
    }
    expect(peak).toBeLessThan(50);
    f.reset();
    expect(f.process(0)).toBe(0);
  });
});

describe('EnvelopeFollower', () => {
  it('peak mode: attack and release time constants', () => {
    const env = new EnvelopeFollower(SR, 10, 100);
    let y = 0;
    for (let i = 0; i < 480; i++) y = env.process(-1); // |x|
    expect(y).toBeCloseTo(1 - Math.exp(-1), 2);
    for (let i = 0; i < SR; i++) env.process(1);
    for (let i = 0; i < 4800; i++) y = env.process(0);
    expect(y).toBeCloseTo(Math.exp(-1), 2);
    expect(env.value).toBe(y);
  });

  it('instant attack follows peaks; rms mode reads a sine at amplitude / √2', () => {
    const fast = new EnvelopeFollower(SR, 0, 50);
    expect(fast.process(0.8)).toBe(0.8);
    expect(fast.process(-0.9)).toBe(0.9);
    const rms = new EnvelopeFollower(SR, 50, 50, 'rms');
    let y = 0;
    for (let i = 0; i < SR; i++) y = rms.process(0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    expect(y).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('smooths a non-negative control signal, keeps the level across a mode switch, flushes and resets', () => {
    const env = new EnvelopeFollower(SR, 1, 1);
    for (let i = 0; i < SR; i++) env.process(6);
    expect(env.value).toBeCloseTo(6, 6);
    env.setMode('rms');
    expect(env.value).toBeCloseTo(6, 6);
    env.setMode('peak');
    for (let i = 0; i < SR; i++) env.process(0);
    expect(env.value).toBe(0);
    env.process(1);
    env.reset();
    expect(env.value).toBe(0);
    env.setTimes(0, 0);
    expect(env.process(0.3)).toBeCloseTo(0.3, 12);
    expect(env.process(0.1)).toBeCloseTo(0.1, 12);
  });
});
