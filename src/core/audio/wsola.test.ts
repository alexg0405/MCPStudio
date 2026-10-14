import { describe, expect, it } from 'vitest';
import { autocorrelationPitch, clickTrain, harmonicTone, onsetFrames, rmsOf, sine } from '../../../test/helpers/audio';
import { timeStretch } from './wsola';

const SR = 48000;

describe('WSOLA time-stretch', () => {
  it('makes the audio exactly scale × as long', () => {
    const x = harmonicTone(220, 1, SR);
    for (const scale of [0.5, 0.8, 1, 1.25, 2]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      expect(y!.length).toBe(Math.round(x.length * scale));
    }
  });

  it('keeps the pitch while changing the duration', () => {
    const x = harmonicTone(220, 1.5, SR);
    expect(autocorrelationPitch(x, SR, 0, SR)).toBeCloseTo(220, 0);
    for (const scale of [0.7, 1.5, 2]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      const mid = Math.floor(y!.length / 2);
      const hz = autocorrelationPitch(y!, SR, mid - SR / 4, mid + SR / 4);
      expect(Math.abs(hz / 220 - 1)).toBeLessThan(0.005);
    }
  });

  it('moves every hit to its stretched time', () => {
    const x = clickTrain(0.25, 2, SR, 0.1);
    for (const scale of [0.75, 1.6]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      const hits = onsetFrames(y!, SR, 0.2, 0.08);
      const want = onsetFrames(x, SR, 0.2, 0.08).map((f) => f * scale);
      expect(hits.length).toBe(want.length);
      // Within the search tolerance plus half a frame.
      hits.forEach((h, i) => expect(Math.abs(h - want[i]!) / SR).toBeLessThan(0.035));
    }
  });

  it('keeps the level and the stereo image', () => {
    const l = sine(330, 1, SR, 0.5);
    const r = sine(330, 1, SR, 0.5);
    const [a, b] = timeStretch([l, r], 1.3, { sampleRate: SR });
    expect(a).toEqual(b);
    const level = rmsOf(a!, SR / 4, a!.length - SR / 4) / rmsOf(l);
    expect(Math.abs(20 * Math.log10(level))).toBeLessThan(1);
  });
});
