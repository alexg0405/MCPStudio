import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../voice/test-signals';
import { bandedDtw, dtwTableBytes } from './dtw';
import { FEATURE_DIM } from './features';

/** Frames of a made-up "voice": bursts of a random pattern with silence (all zero) between them. */
function pattern(frames: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  const vectors = new Float32Array(frames * FEATURE_DIM);
  let i = 10;
  while (i < frames - 30) {
    const length = 15 + Math.floor(random() * 20);
    const shape = Array.from({ length: FEATURE_DIM }, () => random());
    for (let k = 0; k < length && i + k < frames; k++) {
      for (let d = 0; d < FEATURE_DIM; d++) vectors[(i + k) * FEATURE_DIM + d] = (shape[d] as number) * (1 + 0.2 * Math.sin(k));
    }
    i += length + 12 + Math.floor(random() * 25);
  }
  return vectors;
}

/** The same frames read `shift` frames later (the clip is late by that much). */
function shifted(vectors: Float32Array, frames: number, shift: number): Float32Array {
  const out = new Float32Array(vectors.length);
  for (let i = 0; i < frames; i++) {
    const j = i + shift;
    if (j >= 0 && j < frames) out.set(vectors.subarray(i * FEATURE_DIM, (i + 1) * FEATURE_DIM), j * FEATURE_DIM);
  }
  return out;
}

describe('bandedDtw', () => {
  it('returns the diagonal for identical voices', () => {
    const frames = 400;
    const v = pattern(frames, 1);
    const matched = bandedDtw(v, v, frames, { halfBand: 40, stepPenalty: 0.05 });
    for (let i = 0; i < frames; i++) expect(Math.abs((matched[i] as number) - i)).toBeLessThan(0.51);
  });

  it('finds a constant delay inside the band and holds it through the silences', () => {
    const frames = 500;
    const guide = pattern(frames, 2);
    const clip = shifted(guide, frames, 25);
    const matched = bandedDtw(guide, clip, frames, { halfBand: 60, stepPenalty: 0.05 });
    // In the middle of the voice the clip frame is the guide frame plus 25.
    for (let i = 60; i < frames - 80; i++) expect(Math.abs((matched[i] as number) - i - 25)).toBeLessThan(2);
  });

  it('never leaves its band, and goes at most four times as fast or slow', () => {
    const frames = 600;
    const guide = pattern(frames, 3);
    const clip = pattern(frames, 4);
    const halfBand = 30;
    const matched = bandedDtw(guide, clip, frames, { halfBand, stepPenalty: 0.2 });
    for (let i = 0; i < frames; i++) expect(Math.abs((matched[i] as number) - i)).toBeLessThanOrEqual(halfBand);
    for (let i = 4; i < frames; i++) {
      const speed = ((matched[i] as number) - (matched[i - 4] as number)) / 4;
      expect(speed).toBeGreaterThan(0.2);
      expect(speed).toBeLessThan(4.6);
    }
  });

  it('needs memory that grows with the length, not its square', () => {
    expect(dtwTableBytes(36_000, 100)).toBe(36_000 * 201);
    expect(dtwTableBytes(72_000, 100) / dtwTableBytes(36_000, 100)).toBe(2);
    expect(dtwTableBytes(36_000, 100)).toBeLessThan(36_000 ** 2 / 100);
  });

  it('copes with tiny inputs', () => {
    expect(bandedDtw(new Float32Array(0), new Float32Array(0), 0, { halfBand: 5, stepPenalty: 0.1 })).toHaveLength(0);
    const one = new Float32Array(FEATURE_DIM);
    expect(Array.from(bandedDtw(one, one, 1, { halfBand: 5, stepPenalty: 0.1 }))).toEqual([0]);
  });
});
