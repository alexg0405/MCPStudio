import { describe, expect, it } from 'vitest';
import { correlationText, loudnessState, lufsText, monoWarning, peakDbText, peakState, widthText } from './meters-model';

describe('meter text', () => {
  it('writes loudness, peaks, correlation and width the way a meter does', () => {
    expect(lufsText(-14.23)).toBe('−14.2');
    expect(lufsText(-Infinity)).toBe('−∞');
    expect(peakDbText(-0.04)).toBe('−0.0');
    expect(peakDbText(0.3)).toBe('+0.3');
    expect(correlationText(0.824)).toBe('+0.82');
    expect(correlationText(-1)).toBe('−1.00');
    expect(widthText(0.426)).toBe('43 %');
    expect(widthText(3)).toBe('100 %');
  });
});

describe('meter judgement', () => {
  it('compares loudness with the target: on it, near it, off it, or no target', () => {
    expect(loudnessState(-14.6, -14)).toBe('ok');
    expect(loudnessState(-16, -14)).toBe('near');
    expect(loudnessState(-9, -14)).toBe('off');
    expect(loudnessState(-9, null)).toBe('none');
    expect(loudnessState(-Infinity, -14)).toBe('none');
  });

  it('calls a true peak fine up to −1, a warning up to 0 and hot above', () => {
    expect(peakState(-3)).toBe('ok');
    expect(peakState(-0.5)).toBe('warn');
    expect(peakState(0.2)).toBe('hot');
    expect(peakState(-Infinity)).toBe('none');
  });

  it('warns about an out-of-phase bass only when there is bass, and about channels that cancel', () => {
    const fine = { correlation: 0.8, corrLow: 0.9, monoLossLow: -0.2, levelLow: -20 };
    expect(monoWarning(fine)).toBeNull();
    expect(monoWarning({ ...fine, corrLow: -0.6, monoLossLow: -8 })).toContain('bass');
    expect(monoWarning({ ...fine, corrLow: -0.6, monoLossLow: -8, levelLow: -80 })).toBeNull();
    expect(monoWarning({ ...fine, correlation: -0.5 })).toContain('cancel');
  });
});
