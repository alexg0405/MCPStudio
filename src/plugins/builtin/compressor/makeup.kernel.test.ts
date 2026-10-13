import { describe, expect, it } from 'vitest';
import { nativeLatencyFrames, nativeMakeupGain } from './makeup.kernel';

describe('native compressor model', () => {
  // Gains measured from Chrome's DynamicsCompressorNode with a quiet 440 Hz sine (below threshold).
  const measured: [number, number, number, number][] = [
    [-24, 6, 4, 3.03781],
    [-18, 0, 8, 2.9682],
    [-40, 30, 20, 4.42877],
    [-10, 3, 2, 1.34746],
    [0, 0, 1, 1],
  ];

  for (const [threshold, knee, ratio, gain] of measured) {
    it(`matches the browser's makeup gain at ${threshold} dB / ${knee} dB knee / ${ratio}:1`, () => {
      expect(nativeMakeupGain(threshold, knee, ratio) / gain).toBeCloseTo(1, 3);
    });
  }

  it('never attenuates and grows with compression', () => {
    expect(nativeMakeupGain(-12, 6, 4)).toBeGreaterThan(1);
    expect(nativeMakeupGain(-36, 6, 4)).toBeGreaterThan(nativeMakeupGain(-12, 6, 4));
    expect(nativeMakeupGain(-24, 6, 12)).toBeGreaterThan(nativeMakeupGain(-24, 6, 2));
  });

  it('knows the 6 ms look-ahead', () => {
    expect(nativeLatencyFrames(48000)).toBe(288);
    expect(nativeLatencyFrames(44100)).toBe(264);
  });
});
