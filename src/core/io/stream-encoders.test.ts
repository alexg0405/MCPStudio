import { describe, expect, it } from 'vitest';
import { decodeFlac, encodeFlac, FlacStreamEncoder } from './flac';
import { decodePcm, encodeWav, quantizePcm, WavStreamEncoder, type WavBitDepth } from './wav';

const SR = 44100;

/** A few seconds of noisy stereo music-ish audio (deterministic). */
function audio(frames: number): Float32Array[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = 0.5 * Math.sin(i / 9) + 0.2 * rnd();
    r[i] = 0.4 * Math.sin(i / 13) + 0.2 * rnd() + (i % 9000 === 0 ? 1.4 : 0); // a few overs (clipped)
  }
  return [l, r];
}

/** Splits [0, n) into uneven pieces (some empty, some longer than a FLAC block). */
function pieces(n: number): Array<[number, number]> {
  const sizes = [1, 0, 4095, 4097, 13, 10000, 3, 8192, 77];
  const out: Array<[number, number]> = [];
  for (let a = 0, k = 0; a < n; k++) {
    const b = Math.min(n, a + (sizes[k % sizes.length] as number));
    out.push([a, b]);
    a = b;
  }
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('streaming encoders', () => {
  const x = audio(SR * 2 + 123);

  for (const [bits, dither] of [
    [16, true],
    [24, false],
    [32, false],
  ] as Array<[WavBitDepth, boolean]>) {
    it(`write ${bits}-bit WAV byte for byte like encodeWav, however the audio is split`, () => {
      const whole = encodeWav(x, SR, { bitDepth: bits, dither, seed: 3 });
      const enc = new WavStreamEncoder(2, SR, { bitDepth: bits, dither, seed: 3 });
      const parts = [enc.header(0)];
      for (const [a, b] of pieces(x[0]!.length)) parts.push(enc.push(x.map((c) => c.subarray(a, b))));
      parts.push(enc.trailer());
      const streamed = concat(parts);
      streamed.set(enc.header(), 0);
      expect(streamed).toEqual(whole);
      expect(decodePcm(streamed)!.channels[0]!.length).toBe(x[0]!.length);
    });
  }

  for (const bits of [16, 24] as const) {
    it(`write ${bits}-bit FLAC byte for byte like encodeFlac, and it decodes back to the same samples`, () => {
      const opts = { bitDepth: bits, dither: bits === 16, seed: 5 };
      const whole = encodeFlac(x, SR, opts);
      const enc = new FlacStreamEncoder(2, SR, opts);
      const parts = [enc.header()];
      for (const [a, b] of pieces(x[0]!.length)) parts.push(enc.push(x.map((c) => c.subarray(a, b))));
      parts.push(enc.finish());
      const streamed = concat(parts);
      streamed.set(enc.header(), 0);
      expect(streamed).toEqual(whole);
      const back = decodeFlac(streamed);
      expect(back.md5Ok).toBe(true);
      expect(back.channels).toEqual(quantizePcm(x, bits, { dither: bits === 16, seed: 5 }));
    });
  }
});
