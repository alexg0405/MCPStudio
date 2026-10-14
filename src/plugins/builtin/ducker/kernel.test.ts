import { describe, expect, it } from 'vitest';
import type { KernelHost } from '@agstudio/sdk/worklet';
import { paramBlock, runEffect } from '@agstudio/sdk/testing';
import { DuckerKernel, shapeDuck } from './kernel';
import { duckerParams } from './params';

const SR = 48000;
const host: KernelHost = { sampleRate: SR, state: undefined, post: () => {}, rand: () => 0.5 };
type Key = keyof typeof duckerParams;

const params = (overrides: Partial<Record<Key, number>> = {}) => paramBlock(duckerParams, overrides);

/** The ducker's gain over time for a key (main input held at 1). */
function gains(overrides: Partial<Record<Key, number>>, key: (i: number) => number, seconds: number): Float32Array {
  const k = new DuckerKernel(host);
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const p = params(overrides);
  const one = new Float32Array(128).fill(1);
  for (let at = 0; at < n; at += 128) {
    const s = Float32Array.from({ length: 128 }, (_, i) => key(at + i));
    const L = new Float32Array(128);
    k.process([one, one], [L, new Float32Array(128)], 128, p, [s, s]);
    out.set(L.subarray(0, Math.min(128, n - at)), at);
  }
  return out;
}

const ms = (t: number) => Math.round((t * SR) / 1000);
/** A kick every `every` ms: 60 Hz with a 250 ms decay by default (its tail stays above −30 dB for most of a beat). */
const kicks =
  (every: number, peak = 0.6, decay = 0.25) =>
  (i: number) => {
    const t = (i % ms(every)) / SR;
    return peak * Math.exp(-t / decay) * Math.sin(2 * Math.PI * 60 * t);
  };

describe('DuckerKernel', () => {
  it('leaves the signal alone with a silent key', () => {
    const g = gains({}, () => 0, 0.1);
    expect(g.every((x) => x === 1)).toBe(true);
  });

  it('ducks to 1 − depth on each hit, holds, then recovers over the release despite the kick’s tail', () => {
    const settings = { depth: 0.75, threshold: -30, attack: 1, hold: 20, release: 100, curve: 0 };
    const g = gains(settings, kicks(500), 1.6);
    for (const beat of [0, 500, 1000]) {
      const t0 = ms(beat);
      // The 60 Hz kick's first peak (4 ms in) triggers it.
      const start = g.findIndex((x, i) => i >= t0 && x < 1);
      expect(start - t0).toBeLessThan(ms(5));
      expect(g[start + ms(1.1)]).toBeCloseTo(0.25, 6);
      expect(g[start + ms(20)]).toBeCloseTo(0.25, 6); // hold
      expect(g[start + ms(21) + ms(50)]).toBeCloseTo(0.625, 2); // halfway through a linear release
      expect(g[start + ms(21) + ms(101)]).toBe(1);
      // Up for the rest of the beat, even though the tail is still above the threshold.
      for (let i = start + ms(125); i < t0 + ms(495); i += ms(5)) expect(g[i]).toBe(1);
    }
  });

  it('ignores hits below the threshold', () => {
    const g = gains({ threshold: -12 }, kicks(250, 0.1), 0.6);
    expect(Math.min(...g)).toBe(1);
  });

  it('bends the release with the curve', () => {
    expect(shapeDuck(0.5, 0)).toBe(0.5);
    expect(shapeDuck(0.5, 1)).toBeGreaterThan(0.8); // stays down longer (pumping)
    expect(shapeDuck(0.5, -1)).toBeLessThan(0.1); // comes back fast
    expect(shapeDuck(0, 1)).toBe(0);
    expect(shapeDuck(1, -1)).toBe(1);
    const settings = { depth: 1, threshold: -30, attack: 0, hold: 0, release: 200 };
    const pump = gains({ ...settings, curve: 0.8 }, kicks(1000), 0.3);
    const linear = gains({ ...settings, curve: 0 }, kicks(1000), 0.3);
    expect(pump[ms(120)]).toBeLessThan(linear[ms(120)]!);
  });

  it('ducks once for a sustained key, however low its pitch', () => {
    for (const freq of [40, 80, 1000]) {
      const key = (i: number) => 0.5 * Math.min(1, i / ms(30)) * Math.sin((2 * Math.PI * freq * i) / SR);
      const g = gains({ depth: 1, threshold: -30, attack: 1, hold: 0, release: 50, curve: 0 }, key, 1);
      const ducks = g.filter((x, i) => i > 0 && x < 1 && g[i - 1] === 1).length;
      expect(ducks).toBe(1);
    }
  });

  it('a hit during the release ducks again from where it is', () => {
    const g = gains(
      { depth: 1, threshold: -30, attack: 10, hold: 0, release: 200, curve: 0 },
      kicks(100, 0.6, 0.03),
      0.25,
    );
    const second = g.findIndex((x, i) => i > ms(100) && x < g[i - 1]! - 1e-6);
    expect(second).toBeGreaterThan(ms(100));
    expect(second).toBeLessThan(ms(106));
    expect(g[second - 1]).toBeGreaterThan(0);
    expect(Math.min(...g.subarray(second, second + ms(15)))).toBeCloseTo(0, 6);
  });

  describe('tempo pump (no sidechain)', () => {
    const pump = (opts: { bpm?: number; playing?: boolean; beat?: number; params?: Record<string, number | string> }) =>
      runEffect(DuckerKernel, duckerParams, () => 1, 2 * SR, {
        params: { mode: 'tempo', depth: 0.8, attack: 1, hold: 10, release: 200, curve: 0, ...opts.params },
        transport: { bpm: opts.bpm ?? 120, playing: opts.playing ?? true, beat: opts.beat ?? 0 },
      })[0];

    it('ducks on every beat of the song, whatever the key does', () => {
      const g = pump({});
      const beat = SR / 2; // 120 BPM
      for (let b = 0; b < 4; b++) {
        const t0 = b * beat;
        expect(g[t0 + ms(0.5)]).toBeLessThan(1);
        expect(g[t0 + ms(2)]).toBeCloseTo(0.2, 6); // down to 1 − depth after the attack
        expect(g[t0 + ms(10)]).toBeCloseTo(0.2, 6); // hold
        expect(g[t0 + ms(300)]).toBe(1); // back up well before the next beat
        if (b > 0) expect(g[t0 - 1]).toBe(1);
      }
    });

    it('follows the tempo and the grid', () => {
      const g = pump({ bpm: 90, params: { rate: '1/8' } });
      const step = Math.round((SR * 60) / 90 / 2);
      for (let k = 1; k < 5; k++) {
        expect(g[k * step - 2]).toBe(1);
        expect(g[k * step + ms(2)]).toBeCloseTo(0.2, 4);
      }
      // Starting mid-beat waits for the next grid line.
      const late = pump({ beat: 0.5 });
      expect(late[ms(5)]).toBe(1);
      expect(late[SR / 4 + ms(2)]).toBeCloseTo(0.2, 4);
    });

    it('fits the release into one step, so fast pumps still come back up', () => {
      const g = pump({ params: { rate: '1/16', release: 2000, hold: 0 } });
      const step = SR / 8; // a 1/16 at 120 BPM
      for (let k = 1; k < 6; k++) expect(g[k * step - 1]).toBeGreaterThan(0.99);
    });

    it('does nothing while the song is stopped', () => {
      expect(pump({ playing: false }).every((v) => v === 1)).toBe(true);
    });
  });
});
