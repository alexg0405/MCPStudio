import { describe, expect, it } from 'vitest';
import { generateReverbIR, irSeconds } from './ir.kernel';

const SR = 48000;
const energy = (x: Float32Array, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += (x[i] as number) ** 2;
  return e;
};

describe('reverb impulse response', () => {
  const opts = { sampleRate: SR, decay: 1.5, damping: 0.5, size: 0.6 };

  it('is deterministic and decorrelated between channels', () => {
    const [l1, r1] = generateReverbIR(opts);
    const [l2] = generateReverbIR(opts);
    expect(l1).toEqual(l2);
    let dot = 0;
    for (let i = 0; i < l1.length; i++) dot += (l1[i] as number) * (r1[i] as number);
    expect(Math.abs(dot)).toBeLessThan(0.2);
    const [other] = generateReverbIR({ ...opts, seed: 99 });
    expect(other).not.toEqual(l1);
  });

  it('has unit energy, a 5 ms fade-in and the requested length', () => {
    const [l, r] = generateReverbIR(opts);
    expect(energy(l)).toBeCloseTo(1, 4);
    expect(energy(r)).toBeCloseTo(1, 4);
    expect(l[0]).toBe(0);
    expect(l.length).toBe(Math.ceil(irSeconds(1.5, 0.6) * SR));
    for (const x of l) expect(Number.isFinite(x)).toBe(true);
  });

  it('decays by about 60 dB over RT60', () => {
    const [l] = generateReverbIR({ ...opts, damping: 0 });
    const win = Math.round(0.05 * SR);
    const at = (t: number) => energy(l, Math.round(t * SR), Math.round(t * SR) + win);
    // 0.1 s → 1.6 s is one RT60 of the mids (lows ring a little longer).
    const drop = 10 * Math.log10(at(0.1) / at(1.6));
    expect(drop).toBeGreaterThan(45);
    expect(drop).toBeLessThan(65);
  });

  it('longer decays make longer, not louder, tails', () => {
    const [short] = generateReverbIR({ ...opts, decay: 0.5 });
    const [long] = generateReverbIR({ ...opts, decay: 4 });
    expect(long.length).toBeGreaterThan(short.length * 4);
    expect(energy(long)).toBeCloseTo(energy(short), 4);
  });

  it('damping darkens the tail', () => {
    // High-frequency content late in the tail: energy of the first difference.
    const hf = (x: Float32Array) => {
      let e = 0;
      for (let i = Math.round(0.5 * SR); i < Math.round(1 * SR); i++)
        e += ((x[i] as number) - (x[i - 1] as number)) ** 2;
      return e / energy(x, Math.round(0.5 * SR), Math.round(1 * SR));
    };
    const [bright] = generateReverbIR({ ...opts, damping: 0 });
    const [dark] = generateReverbIR({ ...opts, damping: 1 });
    expect(hf(dark)).toBeLessThan(hf(bright) * 0.5);
  });
});
