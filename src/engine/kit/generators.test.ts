import { describe, expect, it } from 'vitest';
import { GENRE_KITS, GENRE_SOUNDS, KIT, KIT_STYLES, kitPiece, kitPieceFor } from '@core/model/kit';
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

const peakOf = (chs: Float32Array[]) => chs.reduce((m, ch) => ch.reduce((a, v) => Math.max(a, Math.abs(v)), m), 0);
const seconds = (chs: Float32Array[]) => chs[0]!.length / 48000;

describe('genre kits', () => {
  const pieces = Object.values(GENRE_KITS).flat();

  it('has every piece of every genre kit, named for its kit', () => {
    expect(pieces.map((p) => p.generator)).toContain('kit/trap/kick');
    expect(pieces).toHaveLength(KIT_STYLES.length * GENRE_SOUNDS.length);
    for (const p of pieces) {
      expect(GENERATORS[p.generator], p.generator).toBeTypeOf('function');
      expect(kitPiece(p.generator)).toBe(p);
    }
    expect(kitPiece('kit/lofi/open-hat')).toMatchObject({ name: 'Lo-fi open hat', sound: 'open-hat', kit: 'lofi' });
    expect(kitPieceFor('kick', 'house')?.generator).toBe('kit/house/kick');
    expect(kitPieceFor('crash', 'house')?.generator).toBe('kit/crash');
    expect(kitPieceFor('hat')?.generator).toBe('kit/hat-closed');
  });

  for (const piece of pieces) {
    it(`${piece.name}: finite, the stock kit's peak, faded out, deterministic, its own sound`, () => {
      const a = generate(piece.generator, 48000)!;
      const b = generate(piece.generator, 48000)!;
      for (const ch of a) {
        expect(ch.every((v) => Number.isFinite(v))).toBe(true);
        expect(Math.abs(ch[ch.length - 1] as number)).toBeLessThan(1e-3);
      }
      const stock = generate(kitPieceFor(piece.sound)!.generator, 48000)!;
      expect(peakOf(a)).toBeCloseTo(peakOf(stock), 5);
      expect(hash(a)).toBe(hash(b));
      expect(hash(a)).not.toBe(hash(stock));
      expect(seconds(a)).toBeGreaterThan(0.02);
      expect(seconds(a)).toBeLessThanOrEqual(3);
    });
  }

  it('sounds like its genre: a short tight 909 kick, a long dusty lo-fi hat', () => {
    expect(seconds(generate('kit/house/kick', 48000)!)).toBeLessThan(seconds(generate('kit/boombap/kick', 48000)!));
    expect(seconds(generate('kit/trap/hat', 48000)!)).toBeLessThan(seconds(generate('kit/lofi/hat', 48000)!));
  });
});
