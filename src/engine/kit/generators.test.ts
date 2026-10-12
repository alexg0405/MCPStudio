import { describe, expect, it } from 'vitest';
import { KIT } from '@core/model/kit';
import { GENERATORS, generate } from './generators';

function hash(chs: Float32Array[]): number {
  let h = 2166136261;
  for (const ch of chs) {
    const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength);
    for (let i = 0; i < bytes.length; i += 7) h = Math.imul(h ^ (bytes[i] as number), 16777619);
  }
  return h >>> 0;
}

describe('procedural kit', () => {
  it('has a generator for every catalogue entry', () => {
    for (const piece of KIT) expect(GENERATORS[piece.generator], piece.generator).toBeTypeOf('function');
  });

  for (const piece of KIT) {
    it(`${piece.name}: finite, in range, faded out, deterministic`, () => {
      const a = generate(piece.generator, 48000)!;
      const b = generate(piece.generator, 48000)!;
      expect(a.length).toBeGreaterThan(0);
      let peak = 0;
      for (const ch of a) {
        for (let i = 0; i < ch.length; i++) {
          const v = ch[i] as number;
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(Math.abs(ch[ch.length - 1] as number)).toBeLessThan(1e-3);
      }
      expect(peak).toBeGreaterThan(0.5);
      expect(peak).toBeLessThanOrEqual(1);
      expect(hash(a)).toBe(hash(b));
    });
  }

  it('scales length with the sample rate', () => {
    const k44 = generate('kit/kick', 44100)![0]!;
    const k96 = generate('kit/kick', 96000)![0]!;
    expect(k96.length / k44.length).toBeCloseTo(96000 / 44100, 2);
  });
});
