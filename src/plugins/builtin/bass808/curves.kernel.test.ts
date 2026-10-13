import { describe, expect, it } from 'vitest';
import {
  clickWave,
  CLICK_SECONDS,
  CURVE_POINTS,
  CURVE_RANGE,
  driveCurve,
  driveGain,
  driveMakeup,
} from './curves.kernel';

/** What the shaper chain does to a sample at a given drive (pre-gain → curve → make-up). */
function drive(d: number, x: number): number {
  const c = driveCurve();
  const u = Math.max(-1, Math.min(1, (driveGain(d) * x) / CURVE_RANGE));
  // WaveShaperNode's linear interpolation.
  const pos = ((u + 1) / 2) * (CURVE_POINTS - 1);
  const i = Math.min(CURVE_POINTS - 2, Math.floor(pos));
  const f = pos - i;
  return driveMakeup(d) * ((c[i] as number) * (1 - f) + (c[i + 1] as number) * f);
}

/** Harmonic k of a full-level sine through the drive, relative to the fundamental, in dB. */
function harmonicDb(d: number, k: number): number {
  const n = 2048;
  const amp = (h: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const y = drive(d, Math.sin(th));
      re += y * Math.cos(h * th);
      im += y * Math.sin(h * th);
    }
    return Math.hypot(re, im);
  };
  return 20 * Math.log10(amp(k) / amp(1));
}

describe('808 drive curve', () => {
  it('is odd, silent at 0 and bounded', () => {
    const c = driveCurve();
    const mid = (CURVE_POINTS - 1) / 2;
    expect(c.length).toBe(CURVE_POINTS);
    expect(c[mid]).toBe(0);
    for (let i = 0; i < CURVE_POINTS; i += 61) {
      expect(c[i]).toBeCloseTo(-(c[CURVE_POINTS - 1 - i] as number), 6);
      expect(Math.abs(c[i] as number)).toBeLessThanOrEqual(1);
    }
    expect(c[CURVE_POINTS - 1]).toBeGreaterThan(0.9999);
  });

  it('is clean at drive 0 (unity gain, no audible harmonics)', () => {
    for (const x of [1e-3, 0.1, 0.5]) expect(drive(0, x) / x).toBeCloseTo(1, 2);
    expect(harmonicDb(0, 3)).toBeLessThan(-55);
  });

  it('gets warm before it gets harsh', () => {
    // Warm: a little third harmonic, nothing high.
    expect(harmonicDb(0.25, 3)).toBeGreaterThan(-45);
    expect(harmonicDb(0.25, 3)).toBeLessThan(-30);
    expect(harmonicDb(0.25, 7)).toBeLessThan(-90);
    expect(harmonicDb(0.5, 3)).toBeGreaterThan(-25);
    expect(harmonicDb(0.5, 7)).toBeLessThan(-40);
    // Harsh: high harmonics close to a square wave's (-17 dB for the 7th).
    expect(harmonicDb(1, 7)).toBeGreaterThan(-20);
    expect(harmonicDb(1, 11)).toBeGreaterThan(-25);
    // Odd curve: no even harmonics.
    expect(harmonicDb(0.75, 2)).toBeLessThan(-100);
    // More drive, more harmonics.
    for (const k of [3, 5, 7]) {
      let last = -Infinity;
      for (const d of [0, 0.25, 0.5, 0.75, 1]) {
        const h = harmonicDb(d, k);
        expect(h).toBeGreaterThan(last);
        last = h;
      }
    }
  });

  it('keeps a full-level sine at the same RMS whatever the drive', () => {
    for (const d of [0, 0.3, 0.6, 1]) {
      let sum = 0;
      const n = 1000;
      for (let i = 0; i < n; i++) sum += drive(d, Math.sin((2 * Math.PI * (i + 0.5)) / n)) ** 2;
      expect(Math.sqrt(sum / n)).toBeCloseTo(Math.SQRT1_2, 2);
    }
    expect(driveGain(0)).toBeCloseTo(0.1, 12);
    expect(driveGain(1)).toBeCloseTo(0.1 * 10 ** 2.5, 9);
  });
});

describe('808 click', () => {
  it('is a short, peak-normalized burst that starts and ends at zero', () => {
    for (const sr of [44100, 48000, 96000]) {
      const c = clickWave(sr);
      expect(c.length).toBe(Math.round(CLICK_SECONDS * sr));
      expect(c[0]).toBe(0);
      expect(c[c.length - 1]).toBeCloseTo(0, 6);
      expect(Math.max(...c.map(Math.abs))).toBeCloseTo(1, 6);
      expect(clickWave(sr)).toEqual(c);
    }
  });
});
