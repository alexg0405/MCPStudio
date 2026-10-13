import { describe, expect, it } from 'vitest';
import type { KernelHost } from '@agstudio/sdk/worklet';
import { CompressorKernel, gainReduction } from './kernel';
import { compressorParams } from './params';

const SR = 48000;
const host: KernelHost = { sampleRate: SR, state: undefined, post: () => {}, rand: () => 0.5 };
type Key = keyof typeof compressorParams;

function params(overrides: Partial<Record<Key, number>> = {}) {
  const out: Record<string, Float32Array> = {};
  for (const [k, spec] of Object.entries(compressorParams)) {
    const def = typeof spec.default === 'boolean' ? Number(spec.default) : spec.default;
    out[k] = new Float32Array([overrides[k as Key] ?? def]);
  }
  return out as never;
}

/** Runs the kernel over `seconds` of `main(i)` (and `key(i)` as the sidechain); returns the left output. */
function run(
  overrides: Partial<Record<Key, number>>,
  main: (i: number) => number,
  seconds: number,
  key?: (i: number) => number,
): Float32Array {
  const k = new CompressorKernel(host);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const p = params(overrides);
  const block = (f: (i: number) => number, at: number) => Float32Array.from({ length: 128 }, (_, i) => f(at + i));
  for (let at = 0; at < n; at += 128) {
    const m = block(main, at);
    const s = key ? block(key, at) : m;
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    k.process([m, m], [L, R], 128, p, [s, s]);
    out.set(L.subarray(0, Math.min(128, n - at)), at);
  }
  return out;
}

const db = (x: number) => 20 * Math.log10(Math.abs(x));

describe('compressor gain computer', () => {
  it('hard knee: nothing below the threshold, (1 − 1/ratio) of the excess above', () => {
    expect(gainReduction(-30, -18, 4, 0)).toBe(0);
    expect(gainReduction(-6, -18, 4, 0)).toBeCloseTo(9, 9);
    expect(gainReduction(-6, -18, 1, 0)).toBe(0);
  });

  it('soft knee: quadratic around the threshold, continuous at both ends', () => {
    expect(gainReduction(-18, -18, 4, 6)).toBeCloseTo((0.75 * 6) / 8, 9);
    expect(gainReduction(-21.0001, -18, 4, 6)).toBeCloseTo(0, 6);
    expect(gainReduction(-14.9999, -18, 4, 6)).toBeCloseTo(0.75 * 3, 3);
    expect(gainReduction(-24, -18, 4, 6)).toBe(0);
  });
});

describe('CompressorKernel', () => {
  it('passes quiet signals bit-exact and adds no latency', () => {
    const x = (i: number) => 0.01 * Math.sin(i * 0.05) + (i === 300 ? 0.02 : 0);
    const out = run({ threshold: -24, knee: 6, ratio: 4 }, x, 0.05);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(Math.fround(x(i)));
  });

  it('settles at the static curve for a steady level, plus makeup', () => {
    // A constant 0.5 (−6.02 dB) is 11.98 dB over −18 dB: at 4:1 it comes out 8.98 dB down, then +3 dB.
    const out = run(
      { threshold: -18, ratio: 4, knee: 0, attack: 1, release: 100, makeup: 3 },
      () => 0.5,
      0.3,
      () => 0.5,
    );
    expect(db(out[out.length - 1]!) - db(0.5)).toBeCloseTo(3 - 0.75 * (db(0.5) + 18), 4);
  });

  it('attacks and releases with its time constants', () => {
    const loud = (i: number) => (i < SR * 0.2 ? 1 : 0.001);
    const key = (i: number) => (i < SR * 0.2 ? 1 : 0.001);
    const out = run({ threshold: -20, ratio: 20, knee: 0, attack: 10, release: 100, makeup: 0 }, () => 1, 0.5, key);
    const full = 19; // (1 − 1/20) · 20 dB
    // After one attack time constant: 63 % of the reduction.
    expect(-db(out[480]!)).toBeCloseTo(full * (1 - Math.exp(-1)), 0);
    // One release time constant after the key drops: 37 % of it is left.
    expect(-db(out[Math.round(SR * 0.2) + 4800]!)).toBeCloseTo(full * Math.exp(-1), 0);
    expect(loud(0)).toBe(1);
  });

  it('listens to the sidechain: a quiet track ducks under a loud key', () => {
    const main = (i: number) => 0.05 * Math.sin(i * 0.03);
    const key = (i: number) => (i % 4800 < 480 ? 0.9 * Math.sin(i * 0.01) : 0);
    const out = run({ threshold: -30, ratio: 10, knee: 0, attack: 0.5, release: 15 }, main, 0.3, key);
    // Right after a key burst the track is well down; long after it, back to unity.
    const hit = Math.max(...Array.from(out.subarray(4800 + 300, 4800 + 480), Math.abs));
    expect(db(hit) - db(0.05)).toBeLessThan(-10);
    const later = Math.max(...Array.from(out.subarray(4800 + 4000, 4800 + 4700), Math.abs));
    expect(db(later) - db(0.05)).toBeGreaterThan(-1);
  });

  it('the sidechain filter ignores lows, and listen outputs the filtered key', () => {
    const sub = (i: number) => 0.5 * Math.sin((2 * Math.PI * 40 * i) / SR);
    const settings = { threshold: -30, ratio: 10, knee: 0, attack: 1, release: 50 };
    const plain = run({ ...settings, scFilter: 20 }, () => 0.1, 0.5, sub);
    const filtered = run({ ...settings, scFilter: 1000 }, () => 0.1, 0.5, sub);
    expect(db(filtered[filtered.length - 1]!)).toBeGreaterThan(db(plain[plain.length - 1]!) + 15);
    const heard = run({ ...settings, scFilter: 20, listen: 1 }, () => 0.1, 0.5, sub);
    expect(Math.max(...Array.from(heard.subarray(SR * 0.4), Math.abs))).toBeCloseTo(0.5, 1);
  });

  it('resets its filters and detector', () => {
    const k = new CompressorKernel(host);
    const p = params({ threshold: -40 });
    const big = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
    k.process(big, [new Float32Array(128), new Float32Array(128)], 128, p, big);
    k.reset();
    const quiet = [new Float32Array(128).fill(0.001), new Float32Array(128).fill(0.001)];
    const out = [new Float32Array(128), new Float32Array(128)];
    k.process(quiet, out, 128, p, quiet);
    expect(out[0]![0]).toBe(Math.fround(0.001));
  });
});
