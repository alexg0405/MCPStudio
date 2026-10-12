import { describe, expect, it } from 'vitest';
import { Rng } from '@agstudio/sdk/dsp/random';
import { PluckKernel } from './kernel';
import { pluckParams } from './params';

const SR = 48000;

function params(overrides: Partial<Record<keyof typeof pluckParams, number>> = {}) {
  const out: Record<string, Float32Array> = {};
  for (const [k, spec] of Object.entries(pluckParams))
    out[k] = new Float32Array([overrides[k as keyof typeof pluckParams] ?? spec.default]);
  return out as never;
}

function render(key: number, seconds: number) {
  const rng = new Rng(5);
  const k = new PluckKernel({ sampleRate: SR, state: undefined, post: () => {}, rand: () => rng.next() });
  k.noteOn(key, 1, 1, 0);
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const p = params();
  for (let i = 0; i < n; i += 128) k.render([L, R], i, Math.min(n, i + 128), p);
  return { L, kernel: k };
}

/** Fundamental via autocorrelation peak (with parabolic interpolation). */
function pitch(x: Float32Array, start: number, len: number): number {
  let best = 0;
  let bestLag = 0;
  const corr = (lag: number) => {
    let s = 0;
    for (let i = start; i < start + len; i++) s += (x[i] as number) * (x[i + lag] as number);
    return s;
  };
  for (let lag = 20; lag < 2000; lag++) {
    const c = corr(lag);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  const a = corr(bestLag - 1);
  const b = corr(bestLag);
  const c = corr(bestLag + 1);
  const shift = (a - c) / (2 * (a - 2 * b + c));
  return SR / (bestLag + shift);
}

describe('PluckKernel', () => {
  it('plays A5 (MIDI 69) at 440 Hz within 1%', () => {
    const { L } = render(69, 0.5);
    const f = pitch(L, 4800, 4800);
    expect(Math.abs(f - 440) / 440).toBeLessThan(0.01);
  });

  it('stays in tune high up the keyboard', () => {
    const { L } = render(93, 0.3); // A7 = 1760 Hz
    const f = pitch(L, 2400, 2400);
    expect(Math.abs(f - 1760) / 1760).toBeLessThan(0.01);
  });

  it('decays, stays finite and frees the voice after release', () => {
    const rng = new Rng(9);
    const k = new PluckKernel({ sampleRate: SR, state: undefined, post: () => {}, rand: () => rng.next() });
    k.noteOn(60, 1, 7, 0);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    const p = params({ release: 0.05 });
    let early = 0;
    let late = 0;
    for (let b = 0; b < 2000; b++) {
      L.fill(0);
      R.fill(0);
      if (b === 40) k.noteOff(7);
      k.render([L, R], 0, 128, p);
      for (const x of L) {
        expect(Number.isFinite(x)).toBe(true);
        if (b < 20) early = Math.max(early, Math.abs(x));
        if (b > 1500) late = Math.max(late, Math.abs(x));
      }
    }
    expect(early).toBeGreaterThan(0.05);
    expect(late).toBe(0);
  });
});
