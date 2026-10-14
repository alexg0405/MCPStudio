import { describe, expect, it } from 'vitest';
import { runEffect, type TestSignal } from '@agstudio/sdk/testing';
import { BAND_TYPES, bandResponseDb, sectionBuffer, type BandType } from './design.kernel';
import { EqProKernel } from './kernel';
import { eqProParams } from './params';
import eqPro from './index';

const SR = 48000;

/** The kernel's response in dB at `freq`, from its impulse response (DFT at one frequency). */
function measured(ir: Float32Array, freq: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freq) / SR;
  for (let n = 0; n < ir.length; n++) {
    re += (ir[n] as number) * Math.cos(w * n);
    im -= (ir[n] as number) * Math.sin(w * n);
  }
  return 10 * Math.log10(re * re + im * im);
}

const impulse: TestSignal = (i) => (i === 0 ? 1 : 0);

describe('EqProKernel', () => {
  it('returns the input unchanged with every band off', () => {
    const x: TestSignal = (i, c) => Math.sin(i * 0.01 + c) * 0.5;
    const [l, r] = runEffect(EqProKernel, eqProParams, x, 4096);
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(Math.fround(x(i, 0)));
      expect(r[i]).toBe(Math.fround(x(i, 1)));
    }
  });

  it('every band type does what its drawn curve says', () => {
    const scratch = sectionBuffer();
    const cases: { type: BandType; freq: number; gain: number; q: number }[] = BAND_TYPES.flatMap((type) => [
      { type, freq: 1000, gain: 6, q: 0.71 },
      { type, freq: 150, gain: -9, q: 2.5 },
    ]);
    for (const c of cases) {
      const [ir] = runEffect(EqProKernel, eqProParams, impulse, SR, {
        params: { b4On: true, b4Type: c.type, b4Freq: c.freq, b4Gain: c.gain, b4Q: c.q },
      });
      for (const f of [40, 100, 150, 300, 1000, 2000, 5000, 12000]) {
        const want = bandResponseDb(c.type, c.freq, c.gain, c.q, f, SR, scratch);
        const got = measured(ir, f);
        // Deep notches and stop bands only need to be deep.
        if (want < -40) expect(got, `${c.type} @${c.freq}: ${f} Hz`).toBeLessThan(-35);
        else expect(Math.abs(got - want), `${c.type} @${c.freq}: ${f} Hz`).toBeLessThan(0.05);
      }
    }
  });

  it('bands add up, the output gain applies, and cuts are as steep as they say', () => {
    const scratch = sectionBuffer();
    const [ir] = runEffect(EqProKernel, eqProParams, impulse, SR, {
      params: {
        b2On: true,
        b2Type: 'lowShelf',
        b2Freq: 120,
        b2Gain: 4,
        b5On: true,
        b5Type: 'bell',
        b5Freq: 2500,
        b5Gain: -6,
        b5Q: 1.5,
        output: -3,
      },
    });
    for (const f of [60, 500, 2500, 8000]) {
      const want =
        bandResponseDb('lowShelf', 120, 4, Math.SQRT1_2, f, SR, scratch) +
        bandResponseDb('bell', 2500, -6, 1.5, f, SR, scratch) -
        3;
      expect(Math.abs(measured(ir, f) - want)).toBeLessThan(0.05);
    }
    // An octave past the corner: 12, 24 and 48 dB per octave.
    for (const [type, slope] of [
      ['lowCut12', 12],
      ['lowCut24', 24],
      ['lowCut48', 48],
    ] as const) {
      const db = bandResponseDb(type, 1000, 0, Math.SQRT1_2, 250, SR, scratch);
      expect(db).toBeLessThan(-2 * slope + 3);
      expect(db).toBeGreaterThan(-2 * slope - 3);
    }
  });

  it('switching a band on fades it in instead of clicking', () => {
    const x: TestSignal = (i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const [l] = runEffect(EqProKernel, eqProParams, x, 4096, {
      params: { b4On: (i: number) => (i >= 2048 ? 1 : 0), b4Freq: 1000, b4Gain: 12 },
    });
    let worst = 0;
    for (let i = 1; i < l.length; i++) worst = Math.max(worst, Math.abs(l[i]! - l[i - 1]!));
    // A 1 kHz sine at 0.5 moves at most 0.065 per sample; at +12 dB, 0.26.
    expect(worst).toBeLessThan(0.3);
    expect(Math.max(...Array.from(l.subarray(3500), Math.abs))).toBeGreaterThan(1.5);
  });

  it('every preset is valid and changes the sound', () => {
    const ids = new Set(Object.keys(eqProParams));
    expect(eqPro.presets!.length).toBeGreaterThanOrEqual(5);
    for (const preset of eqPro.presets!) {
      for (const key of Object.keys(preset.params ?? {})) expect(ids.has(key), `${preset.name}: ${key}`).toBe(true);
      expect(Object.entries(preset.params ?? {}).some(([k, val]) => k.endsWith('On') && val === true)).toBe(true);
    }
  });
});
