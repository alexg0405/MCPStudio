import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { VocoderKernel } from './kernel';
import { vocoderParams } from './params';

const SR = 48000;
type Params = TestParams<typeof vocoderParams>;
/** The carrier: a 110 Hz saw at −12 dBFS. */
const saw: TestSignal = (i) => 0.25 * (2 * ((i * 110) / SR - Math.floor((i * 110) / SR)) - 1);
/** A voice-like modulator: 150 Hz with vowel-ish harmonics, on for 250 ms, off for 250 ms. */
const voice: TestSignal = (i) => {
  if (i % (SR / 2) >= SR / 4) return 0;
  let v = 0;
  for (let h = 1; h <= 20; h++) {
    const f = 150 * h;
    const formant = Math.exp(-(((f - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 400) ** 2)) + 0.1;
    v += (formant / h) * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return 0.3 * v;
};
const rmsDb = (a: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += (a[i] as number) ** 2;
  return 10 * Math.log10(s / (to - from) + 1e-30);
};
const run = (params: Params, key: TestSignal = voice, x: TestSignal = saw, frames = SR) =>
  runEffect(VocoderKernel, vocoderParams, x, frames, { params, sidechain: key });

describe('VocoderKernel', () => {
  it('the synth follows the voice: on while it speaks, silent while it doesn’t', () => {
    const [l, r] = run({ noise: 0, sibilance: 0, release: 10 });
    const on = rmsDb(l, SR / 2 + 2000, SR / 2 + SR / 4);
    const off = rmsDb(l, SR / 2 + SR / 4 + 4000, SR);
    expect(on - off).toBeGreaterThan(40);
    // About the carrier's level (−15 dB RMS for a −12 dBFS saw), not wildly louder or quieter.
    expect(on).toBeGreaterThan(-24);
    expect(on).toBeLessThan(-8);
    expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
  });

  it('a silent sidechain gives silence; mix 0 is the plain synth', () => {
    const [quiet] = run({ noise: 1, sibilance: 1 }, () => 0);
    expect(rmsDb(quiet, 1000, SR)).toBeLessThan(-120);
    const [dry] = run({ mix: 0 });
    for (let i = 0; i < 2000; i++) expect(dry[i]).toBe(Math.fround(saw(i, 0)));
  });

  it('band count, width and formant change the sound', () => {
    const base = run({ noise: 0 })[0];
    const diff = (a: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - (base[i] as number))), 0);
    expect(diff(run({ noise: 0, bands: '16' })[0])).toBeGreaterThan(0.01);
    expect(diff(run({ noise: 0, width: 2 })[0])).toBeGreaterThan(0.01);
    expect(diff(run({ noise: 0, formant: -6 })[0])).toBeGreaterThan(0.01);
  });

  it('with no sidechain chosen it keys from its own input (the host feeds it), staying sane', () => {
    let s = 3;
    const drums: TestSignal = (i) => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (i % 12000 < 2000 ? 0.8 : 0.02) * (s / 2147483648 - 1);
    };
    const [l] = runEffect(VocoderKernel, vocoderParams, drums, SR, { sidechain: drums });
    expect(l.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(l, Math.abs))).toBeLessThan(4);
  });
});
