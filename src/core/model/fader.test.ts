import { describe, expect, it } from 'vitest';
import {
  faderToGain,
  formatGain,
  gainToDecibels,
  gainToFader,
  MAX_INSERT_VOLUME,
  UNITY_POSITION,
} from './fader';

describe('fader taper', () => {
  it('puts 0 dB at 80 % of the travel, +5.6 dB at the top and silence at the bottom', () => {
    expect(faderToGain(UNITY_POSITION)).toBeCloseTo(1, 12);
    expect(faderToGain(1)).toBe(MAX_INSERT_VOLUME);
    expect(gainToDecibels(MAX_INSERT_VOLUME)).toBeCloseTo(5.6, 1);
    expect(faderToGain(0)).toBe(0);
    expect(faderToGain(-1)).toBe(0);
    expect(faderToGain(Number.NaN)).toBe(0);
    expect(faderToGain(2)).toBe(MAX_INSERT_VOLUME);
  });

  it('is strictly increasing and gainToFader is its inverse', () => {
    let last = -1;
    for (let pos = 0.001; pos <= 1; pos += 0.001) {
      const g = faderToGain(pos);
      expect(g).toBeGreaterThan(last);
      last = g;
      expect(gainToFader(g)).toBeCloseTo(pos, 9);
    }
    expect(gainToFader(0)).toBe(0);
    expect(gainToFader(10)).toBe(1);
    expect(gainToFader(Number.NaN)).toBe(0);
  });

  it('keeps a wheel notch (1 % of the travel) to a few dB at the top and well under 1 dB near unity', () => {
    const db = (pos: number) => gainToDecibels(faderToGain(pos));
    expect(db(0.81) - db(0.8)).toBeLessThan(0.5);
    expect(db(0.81) - db(0.8)).toBeGreaterThan(0.05);
    // The quiet end is compressed, like a console: a notch covers many dB down there.
    expect(db(0.11) - db(0.1)).toBeGreaterThan(db(0.81) - db(0.8));
  });

  it('formats gains for the readouts', () => {
    expect(formatGain(1)).toBe('0.0 dB');
    expect(formatGain(0.5)).toBe('-6.0 dB');
    expect(formatGain(MAX_INSERT_VOLUME)).toBe('+5.6 dB');
    expect(formatGain(0)).toBe('-∞ dB');
    expect(formatGain(1e-7)).toBe('-∞ dB');
    // A gain a hair below unity never reads "-0.0".
    expect(formatGain(0.9999)).toBe('0.0 dB');
  });
});
