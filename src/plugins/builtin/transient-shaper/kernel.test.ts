import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { TransientKernel } from './kernel';
import { transientParams } from './params';

const SR = 48000;
const ms = (t: number) => Math.round((t * SR) / 1000);
/** A hit every 500 ms: a 200 Hz tone that starts at full level and decays over 150 ms. */
const hits: TestSignal = (i) => {
  const t = (i % ms(500)) / SR;
  return 0.5 * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * 200 * t);
};

/** Peak level of the first 5 ms of the second hit and RMS of its tail (100–300 ms in). */
function shape(params: TestParams<typeof transientParams>) {
  const [l] = runEffect(TransientKernel, transientParams, hits, SR, { params });
  const start = ms(500);
  let peak = 0;
  for (let i = start; i < start + ms(5); i++) peak = Math.max(peak, Math.abs(l[i] as number));
  let sum = 0;
  for (let i = start + ms(100); i < start + ms(300); i++) sum += (l[i] as number) ** 2;
  return { onset: peak, tail: Math.sqrt(sum / ms(200)), out: l };
}

describe('TransientKernel', () => {
  it('leaves the sound unchanged at 0% attack and sustain', () => {
    const { out } = shape({});
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(Math.fround(hits(i, 0)));
  });

  it('attack lifts or softens the start of each hit relative to its tail', () => {
    const plain = shape({});
    const more = shape({ attack: 1 });
    const less = shape({ attack: -1 });
    const contrast = (x: { onset: number; tail: number }) => x.onset / x.tail;
    expect(contrast(more) / contrast(plain)).toBeGreaterThan(1.5);
    expect(contrast(less) / contrast(plain)).toBeLessThan(0.7);
    // The tail itself stays about where it was.
    expect(more.tail / plain.tail).toBeGreaterThan(0.8);
  });

  it('sustain shortens or lengthens the tail', () => {
    const plain = shape({});
    expect(shape({ sustain: -1 }).tail / plain.tail).toBeLessThan(0.5);
    expect(shape({ sustain: 1 }).tail / plain.tail).toBeGreaterThan(1.5);
    expect(shape({ sustain: -1 }).onset / plain.onset).toBeGreaterThan(0.8);
  });

  it('mix blends with the original and output sets the level', () => {
    const plain = shape({});
    const half = shape({ attack: 1, mix: 0 });
    expect(half.onset).toBeCloseTo(plain.onset, 6);
    expect(shape({ output: -6 }).tail / plain.tail).toBeCloseTo(0.5, 2);
  });
});
