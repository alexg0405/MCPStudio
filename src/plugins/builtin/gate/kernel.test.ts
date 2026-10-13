import { describe, expect, it } from 'vitest';
import type { KernelHost } from '@agstudio/sdk/worklet';
import { GateKernel, HYSTERESIS_DB } from './kernel';
import { gateParams } from './params';

const SR = 48000;
const host: KernelHost = { sampleRate: SR, state: undefined, post: () => {}, rand: () => 0.5 };
type Key = keyof typeof gateParams;

function params(overrides: Partial<Record<Key, number>> = {}) {
  const out: Record<string, Float32Array> = {};
  for (const [k, spec] of Object.entries(gateParams)) {
    const def = typeof spec.default === 'boolean' ? Number(spec.default) : spec.default;
    out[k] = new Float32Array([overrides[k as Key] ?? def]);
  }
  return out as never;
}

/** Left output for `main(i)`, keyed by `key(i)` (the main input itself when omitted). */
function run(
  overrides: Partial<Record<Key, number>>,
  main: (i: number) => number,
  seconds: number,
  key?: (i: number) => number,
): Float32Array {
  const k = new GateKernel(host);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const p = params(overrides);
  for (let at = 0; at < n; at += 128) {
    const m = Float32Array.from({ length: 128 }, (_, i) => main(at + i));
    const s = key ? Float32Array.from({ length: 128 }, (_, i) => key(at + i)) : m;
    const L = new Float32Array(128);
    k.process([m, m], [L, new Float32Array(128)], 128, p, [s, s]);
    out.set(L.subarray(0, Math.min(128, n - at)), at);
  }
  return out;
}

const ms = (t: number) => Math.round((t * SR) / 1000);
const dbGain = (db: number) => Math.pow(10, db / 20);

describe('GateKernel', () => {
  it('passes a signal above the threshold and turns one below it down by the range', () => {
    const settings = { threshold: -30, range: -40, attack: 0.1, hold: 0, release: 5 };
    const loud = run(settings, () => 0.5, 0.05);
    expect(loud[loud.length - 1]).toBeCloseTo(0.5, 6);
    const quiet = run(settings, () => 0.01, 0.05);
    expect(quiet[quiet.length - 1]! / 0.01).toBeCloseTo(dbGain(-40), 6);
  });

  it('holds open after the key drops, then closes with the release', () => {
    const key = (i: number) => (i < ms(20) ? 0.5 : 0);
    const out = run({ threshold: -30, range: -80, attack: 0.05, hold: 50, release: 10 }, () => 0.2, 0.2, key);
    expect(out[ms(15)]).toBeCloseTo(0.2, 4);
    expect(out[ms(60)]).toBeCloseTo(0.2, 4); // inside the hold (plus the detector's ring-out)
    expect(out[ms(150)]! / 0.2).toBeLessThan(0.01);
  });

  it('does not chatter around the threshold (hysteresis)', () => {
    // A level that wobbles between 2 dB over and (HYSTERESIS_DB − 1) dB under the threshold stays open.
    const thr = -20;
    const hi = dbGain(thr + 2);
    const lo = dbGain(thr - (HYSTERESIS_DB - 1));
    const wobble = (i: number) => (Math.floor(i / ms(30)) % 2 === 0 ? hi : lo);
    const out = run({ threshold: thr, range: -80, attack: 0.05, hold: 0, release: 1 }, wobble, 0.3);
    for (let i = ms(5); i < out.length; i++) expect(out[i]! / wobble(i)).toBeGreaterThan(0.999);
  });

  it('opens on a sidechain key, and listen outputs the key', () => {
    const hats = (i: number) => (i % ms(100) < ms(5) ? 0.5 : 0);
    const pad = () => 0.1;
    const out = run({ threshold: -20, range: -80, attack: 0.05, hold: 0, release: 2 }, pad, 0.3, hats);
    expect(out[ms(103)]).toBeCloseTo(0.1, 4);
    expect(out[ms(160)]! / 0.1).toBeLessThan(0.001);
    const heard = run({ listen: 1 }, pad, 0.05, hats);
    expect(heard[ms(1)]).toBe(0.5);
    expect(heard[ms(20)]).toBe(0);
  });
});
