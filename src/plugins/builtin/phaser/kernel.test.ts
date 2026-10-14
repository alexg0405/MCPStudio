import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { PhaserKernel } from './kernel';
import { phaserParams } from './params';

const SR = 48000;
type Params = TestParams<typeof phaserParams>;
const sine =
  (freq: number, amp = 0.5) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * freq * i) / SR);
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);

function level(freq: number, params: Params): number {
  const [l] = runEffect(PhaserKernel, phaserParams, sine(freq), SR / 2, { params });
  let sum = 0;
  for (let i = SR / 4; i < SR / 2; i++) sum += (l[i] as number) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / (SR / 4)) / (0.5 * Math.SQRT1_2));
}

/** Where N equal first-order allpasses at fc put the notches of a 50 % mix: N/2 of them. */
function notches(stages: number, fc: number): number[] {
  const tc = Math.tan((Math.PI * fc) / SR);
  const out: number[] = [];
  // Each stage turns the phase by 2·atan(t / tc); notches where the total is an odd multiple of π.
  for (let k = 0; k < stages / 2; k++) {
    const t = tc * Math.tan(((2 * k + 1) * Math.PI) / (2 * stages));
    out.push((Math.atan(t) * SR) / Math.PI);
  }
  return out;
}

describe('PhaserKernel', () => {
  it('passes the input untouched at 0% mix', () => {
    const x: TestSignal = (i, c) => Math.sin(i * 0.01 + c) * 0.5;
    const [l, r] = runEffect(PhaserKernel, phaserParams, x, 4096, { params: { mix: 0 } });
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(Math.fround(x(i, 0)));
      expect(r[i]).toBe(Math.fround(x(i, 1)));
    }
  });

  it('with no sweep, N stages make N/2 notches where theory puts them', () => {
    // Low 500 Hz and High 2 kHz: the still sweep sits at their middle, 1 kHz.
    for (const stages of ['4', '8'] as const) {
      const still: Params = { depth: 0, low: 500, high: 2000, stages, feedback: 0, mix: 0.5 };
      const found = notches(Number(stages), 1000);
      expect(found).toHaveLength(Number(stages) / 2);
      for (const f of found) expect(level(f, still), `${stages} stages: ${f.toFixed(0)} Hz`).toBeLessThan(-30);
      // In between the notches it passes at full level (the phase comes round again).
      expect(Math.abs(level(1000, still))).toBeLessThan(0.1);
    }
  });

  it('stays stable and sane with full feedback and fast sweeps', () => {
    for (const feedback of [-0.9, 0.9]) {
      const [l] = runEffect(PhaserKernel, phaserParams, sine(700), SR, {
        params: { feedback, rate: 5, depth: 1, stages: '12', mix: 1 },
      });
      expect(l.every(Number.isFinite)).toBe(true);
      expect(Math.max(...Array.from(l, Math.abs))).toBeLessThan(6);
    }
  });

  it('a synced sweep follows the song position', () => {
    const run = (beat: number, sync: string) =>
      runEffect(PhaserKernel, phaserParams, sine(500), SR / 2, {
        params: { sync, depth: 1, mix: 0.5, width: 0 },
        transport: { playing: true, bpm: 120, beat },
      })[0];
    expect(maxDiff(run(0, '1/4'), run(1, '1/4'))).toBeLessThan(1e-6);
    expect(maxDiff(run(0, '1/4'), run(0.25, '1/4'))).toBeGreaterThan(0.01);
    expect(maxDiff(run(0, 'off'), run(0.25, 'off'))).toBeLessThan(1e-6);
  });
});
