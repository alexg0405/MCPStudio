import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { LofiKernel } from './kernel';
import { lofiLatencyFrames, lofiParams } from './params';

const SR = 48000;
const D = lofiLatencyFrames(SR);
type Params = TestParams<typeof lofiParams>;
const CLEAN: Params = { bits: 16, rate: 48000, wow: 0, flutter: 0, crackle: 0, noise: 0, tone: 20000, mix: 1 };
const sine =
  (freq: number, amp = 0.5) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * freq * i) / SR);
const run = (params: Params, x: TestSignal = sine(440), frames = SR / 2, seed = 1) =>
  runEffect(LofiKernel, lofiParams, x, frames, { params, seed })[0];

describe('LofiKernel', () => {
  it('is deterministic: the same seed gives the same noise', () => {
    const settings: Params = { crackle: 0.8, noise: 0.6, wow: 0.5 };
    const a = run(settings);
    const b = run(settings);
    expect(a.every((v, i) => v === b[i])).toBe(true);
    const other = run(settings, sine(440), SR / 2, 2);
    expect(a.some((v, i) => v !== other[i])).toBe(true);
  });

  it('clean settings give the input back, delayed by the reported latency', () => {
    expect(D).toBe(384);
    const x = sine(1000);
    const out = run(CLEAN, x);
    let worst = 0;
    for (let i = D + 2000; i < out.length; i++) worst = Math.max(worst, Math.abs((out[i] as number) - x(i - D, 0)));
    expect(worst).toBeLessThan(2e-3);
    // Mix 0 is the dry signal, exactly aligned.
    const dry = run({ ...CLEAN, bits: 2, mix: 0 }, x);
    for (let i = D; i < 3000; i++) expect(dry[i]).toBeCloseTo(x(i - D, 0), 6);
  });

  it('reduces bits and sample rate', () => {
    const crushed = run({ ...CLEAN, bits: 4 }, sine(220, 0.9));
    expect(new Set(crushed.subarray(D)).size).toBeLessThanOrEqual(2 ** 4 + 1);
    const held = run({ ...CLEAN, rate: 6000 }, sine(220, 0.9));
    // At 6 kHz each value is held for 8 frames.
    let repeats = 0;
    for (let i = D + 1; i < held.length; i++) if (held[i] === held[i - 1]) repeats++;
    expect(repeats / (held.length - D)).toBeGreaterThan(0.8);
  });

  it('adds hiss and crackle over silence', () => {
    const quiet = run({ ...CLEAN, noise: 1 }, () => 0, SR);
    const rms = Math.sqrt(quiet.reduce((s, v) => s + v * v, 0) / quiet.length);
    expect(20 * Math.log10(rms)).toBeGreaterThan(-45);
    expect(20 * Math.log10(rms)).toBeLessThan(-20);
    const clicks = run({ ...CLEAN, crackle: 1 }, () => 0, SR);
    const pops = clicks.reduce(
      (n, v, i) => n + (Math.abs(v) > 0.05 && Math.abs(clicks[i - 1] ?? 0) <= 0.05 ? 1 : 0),
      0,
    );
    expect(pops).toBeGreaterThan(10);
    expect(pops).toBeLessThan(60);
  });

  it('wow bends the pitch of a steady tone', () => {
    const x = sine(1000);
    const wobbly = run({ ...CLEAN, wow: 1 }, x, SR * 2);
    // Zero crossings per 100 ms window vary as the pitch moves.
    const rates: number[] = [];
    for (let from = D; from + 4800 < wobbly.length; from += 4800) {
      let z = 0;
      for (let i = from + 1; i < from + 4800; i++) if ((wobbly[i - 1] as number) < 0 && (wobbly[i] as number) >= 0) z++;
      rates.push(z);
    }
    expect(Math.max(...rates) - Math.min(...rates)).toBeGreaterThanOrEqual(2);
  });
});
