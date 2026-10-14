import { describe, expect, it } from 'vitest';
import { decodePcm } from '@core/io/wav';
import { testSoundWav } from './test-sound';

describe('the test sound', () => {
  it('chimes on the left, then on the right, at a gentle level', () => {
    const pcm = decodePcm(testSoundWav(48000));
    expect(pcm?.sampleRate).toBe(48000);
    const [left, right] = pcm!.channels as [Float32Array, Float32Array];
    const firstLoud = (ch: Float32Array) => ch.findIndex((v) => Math.abs(v) > 0.05);
    expect(firstLoud(left)).toBeLessThan(48000 * 0.01);
    expect(firstLoud(right)).toBeGreaterThan(48000 * 0.39);
    const peak = [...left, ...right].reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.5);
    // It fades out completely (no click at the end).
    expect(Math.abs(left.at(-1)!)).toBeLessThan(1e-3);
    expect(Math.abs(right.at(-1)!)).toBeLessThan(1e-3);
  });
});
