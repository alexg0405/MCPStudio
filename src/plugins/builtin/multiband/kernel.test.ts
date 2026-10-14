import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { MultibandKernel } from './kernel';
import { multibandParams } from './params';

const SR = 48000;
type Params = TestParams<typeof multibandParams>;
const sine = (freq: number, amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * freq * i) / SR);

/** Output level of a steady sine in dB relative to its input level (measured on the tail). */
function gainAt(freq: number, amp: number, params: Params = {}): number {
  const [l] = runEffect(MultibandKernel, multibandParams, sine(freq, amp), SR / 2, { params });
  let sum = 0;
  for (let i = SR / 4; i < SR / 2; i++) sum += (l[i] as number) ** 2;
  const rms = Math.sqrt(sum / (SR / 4));
  return 20 * Math.log10(rms / (amp * Math.SQRT1_2));
}

describe('MultibandKernel', () => {
  it('untouched, the three bands sum flat', () => {
    for (const f of [40, 120, 200, 450, 1000, 3000, 6000, 15000]) {
      expect(Math.abs(gainAt(f, 0.1)), `${f} Hz`).toBeLessThan(0.01);
    }
    const crossovers: Params = { lowFreq: 500, highFreq: 2000 };
    for (const f of [100, 500, 1000, 2000, 8000]) expect(Math.abs(gainAt(f, 0.1, crossovers))).toBeLessThan(0.01);
  });

  it('compresses only the band that goes over its threshold', () => {
    const settings: Params = { lowThreshold: -30, lowRatio: 10, lowAttack: 1, lowRelease: 50 };
    // A loud 60 Hz tone is turned down; a loud 5 kHz tone isn't.
    expect(gainAt(60, 0.5, settings)).toBeLessThan(-15);
    expect(Math.abs(gainAt(5000, 0.5, settings))).toBeLessThan(0.05);
    // Makeup gain lifts the band after compressing (12 kHz is two octaves above the crossover).
    expect(gainAt(12000, 0.05, { highGain: 6 })).toBeCloseTo(6, 1);
  });

  it('solo isolates bands; bypass undoes a band’s compression and gain', () => {
    expect(gainAt(100, 0.3, { highSolo: true })).toBeLessThan(-40);
    // 40 Hz is far under the 200 Hz crossover: all of it is in the low band.
    expect(Math.abs(gainAt(40, 0.3, { lowSolo: true }))).toBeLessThan(0.1);
    expect(gainAt(100, 0.3, { lowSolo: true, midSolo: true, highSolo: true })).toBeCloseTo(0, 1);
    const squashed: Params = { lowThreshold: -40, lowRatio: 20, lowGain: -6 };
    expect(gainAt(100, 0.3, squashed)).toBeLessThan(-20);
    expect(Math.abs(gainAt(100, 0.3, { ...squashed, lowBypass: true }))).toBeLessThan(0.05);
  });

  it('stays finite with extreme settings', () => {
    const x: TestSignal = (i, c) => Math.sin(i * (0.01 + 0.3 * c)) * (i % 5000 < 100 ? 1 : 0.01);
    const [l, r] = runEffect(MultibandKernel, multibandParams, x, SR, {
      params: { lowThreshold: -60, lowRatio: 20, lowAttack: 0.5, midGain: 24, highFreq: 1000, lowFreq: 1000 },
    });
    expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
  });
});
