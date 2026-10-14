import { describe, expect, it } from 'vitest';
import { decodeFlac, encodeFlac, encodeFlacPcm } from './flac';
import { md5Hex } from './md5';
import { decodePcm, encodeWav, quantizePcm } from './wav';

const SR = 48000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Music-like test audio: a chord, a decaying hit every 0.25 s and a little noise; R is a delayed, quieter L. */
function music(seconds: number, seed = 1): Float32Array[] {
  const n = Math.round(seconds * SR);
  const r = rng(seed);
  const l = new Float32Array(n);
  const rr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const hit = Math.exp(-((t % 0.25) * 30)) * Math.sin(2 * Math.PI * 80 * t);
    l[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 277.2 * t) + 0.3 * hit + 0.01 * (r() - 0.5);
  }
  for (let i = 0; i < n; i++) rr[i] = 0.8 * (l[Math.max(0, i - 7)] as number);
  return [l, rr];
}

const roundTrip = (channels: Float32Array[], bitDepth: 16 | 24, opts: { dither?: boolean; maxLpcOrder?: number } = {}) => {
  const flac = encodeFlac(channels, SR, { bitDepth, ...opts });
  const want = quantizePcm(channels, bitDepth, { dither: !!opts.dither, seed: 7 });
  const flacSeeded = encodeFlac(channels, SR, { bitDepth, seed: 7, ...opts });
  const got = decodeFlac(flacSeeded);
  return { flac, want, got };
};

describe('FLAC', () => {
  it('round-trips 16-bit stereo bit-exactly, dithered like the WAV encoder', () => {
    const audio = music(1.3);
    const { want, got, flac } = roundTrip(audio, 16, { dither: true });
    expect(got).toMatchObject({ sampleRate: SR, bitDepth: 16, md5Ok: true });
    expect(got.channels).toHaveLength(2);
    got.channels.forEach((c, i) => expect(c).toEqual(want[i]));
    // Lossless, and smaller than the WAV.
    expect(flac.length).toBeLessThan(encodeWav(audio, SR, { bitDepth: 16 }).length * 0.75);
  });

  it('round-trips 24-bit audio, with LPC and with fixed predictors only', () => {
    const audio = music(0.9, 3);
    for (const maxLpcOrder of [0, 8, 12]) {
      const { want, got } = roundTrip(audio, 24, { maxLpcOrder });
      expect(got.md5Ok).toBe(true);
      got.channels.forEach((c, i) => expect(c).toEqual(want[i]));
    }
  });

  it('handles silence, full-scale squares, white noise, mono, short streams and odd rates', () => {
    const n = 9000;
    const r = rng(9);
    const signals: Float32Array[][] = [
      [new Float32Array(n), new Float32Array(n)],
      [new Float32Array(n).map((_, i) => (Math.floor(i / 37) % 2 ? 1 : -1)), new Float32Array(n).fill(-1)],
      [new Float32Array(n).map(() => r() * 2 - 1)],
      [new Float32Array(1).fill(0.5)],
      [new Float32Array(100).map((_, i) => Math.sin(i / 5)), new Float32Array(100)],
    ];
    for (const ch of signals)
      for (const bits of [16, 24] as const) {
        for (const rate of [44100, 22050, 11025]) {
          const pcm = quantizePcm(ch, bits);
          const got = decodeFlac(encodeFlacPcm(pcm, rate, { bitDepth: bits }));
          expect(got.sampleRate).toBe(rate);
          expect(got.md5Ok).toBe(true);
          got.channels.forEach((c, i) => expect(c).toEqual(pcm[i]));
        }
      }
  });

  it('writes a valid stream header (STREAMINFO with the length and MD5)', () => {
    const audio = music(0.5);
    const flac = encodeFlac(audio, SR, { bitDepth: 24 });
    expect(String.fromCharCode(...flac.subarray(0, 4))).toBe('fLaC');
    const got = decodeFlac(flac);
    expect(got.channels[0]!.length).toBe(audio[0]!.length);
    expect(got.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(got.md5).not.toBe('0'.repeat(32));
  });

  it('quantizes exactly like the WAV encoder', () => {
    const audio = music(0.2);
    for (const bits of [16, 24] as const) {
      const pcm = quantizePcm(audio, bits, { dither: bits === 16, seed: 5 });
      const wav = decodePcm(encodeWav(audio, SR, { bitDepth: bits, dither: bits === 16, seed: 5 }));
      const scale = bits === 16 ? 32768 : 8388608;
      pcm.forEach((c, i) => expect(Array.from(c, (v) => v / scale)).toEqual(Array.from(wav!.channels[i]!)));
    }
  });
});

describe('MD5', () => {
  it('matches the RFC 1321 test vectors', () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(md5Hex(text(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(text('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(text('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5Hex(text('1234567890'.repeat(8)))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
});
