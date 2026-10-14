import { describe, expect, it } from 'vitest';
import { BANDS, measure } from './measure';

const SR = 48000;
const sine = (hz: number, amp: number, seconds = 3, phase = 0) =>
  Float32Array.from({ length: SR * seconds }, (_, i) => amp * Math.sin(2 * Math.PI * hz * (i / SR) + phase));
const band = (id: (typeof BANDS)[number]['id']) => BANDS.findIndex((b) => b.id === id);

describe('measure', () => {
  it('reads a −20 dBFS 1 kHz tone in both channels as −20 LUFS, a 3 dB crest, mono', () => {
    const x = sine(1000, 0.1);
    const m = measure(x, x, SR);
    expect(m.peakDb).toBeCloseTo(-20, 1);
    expect(m.rmsDb).toBeCloseTo(-23, 1);
    expect(m.crestDb).toBeCloseTo(3, 1);
    // BS.1770: the K-weighting's +0.69 dB at 1 kHz cancels its −0.691 offset.
    expect(m.lufs).toBeCloseTo(-20, 1);
    expect(m.width).toBeLessThan(1e-6);
    expect(m.correlation).toBeCloseTo(1, 5);
    expect(m.silent).toBe(false);
  });

  it('puts a tone’s energy in its band', () => {
    const lowTone = sine(40, 0.3);
    expect(measure(lowTone, lowTone, SR).bands[band('sub')]).toBeGreaterThan(85);
    const midTone = sine(2000, 0.3);
    expect(measure(midTone, midTone, SR).bands[band('mid')]).toBeGreaterThan(85);
    const airTone = sine(14000, 0.3);
    const m = measure(airTone, airTone, SR);
    expect(m.bands[band('air')]).toBeGreaterThan(85);
    expect(m.bands.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  it('sees width and phase: opposite channels are wide and cancel in mono', () => {
    const l = sine(500, 0.2);
    const r = l.map((v) => -v);
    const m = measure(l, r, SR);
    expect(m.width).toBeGreaterThan(100);
    expect(m.correlation).toBeCloseTo(-1, 5);
  });

  it('finds peaks between the samples when asked', () => {
    // A quarter-sample-rate sine sampled 45° off its peaks: the samples reach only 0.707 of it.
    const x = sine(SR / 4, 0.9, 1, Math.PI / 4);
    const m = measure(x, x, SR, true);
    expect(m.peakDb).toBeCloseTo(20 * Math.log10(0.9 * Math.SQRT1_2), 1);
    expect(m.truePeakDb!).toBeGreaterThan(m.peakDb + 2.5);
    expect(measure(x, x, SR).truePeakDb).toBeNull();
  });

  it('calls silence silent', () => {
    const z = new Float32Array(SR);
    const m = measure(z, z, SR);
    expect(m.silent).toBe(true);
    expect(m.lufs).toBe(-Infinity);
  });
});
