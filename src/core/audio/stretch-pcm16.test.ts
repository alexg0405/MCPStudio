import { describe, expect, it } from 'vitest';
import { decodePcm16, encodePcm16 } from '@core/io/pcm16';
import { stretchToPcm16 } from './stretch-pcm16';
import { stretchStream, timeStretch } from './wsola';

const SR = 48000;

/** Tones, clicks every half second and a noise burst: all seeded, so the same every time. */
function signal(channels: number, seconds: number, gain = 1): Float32Array[] {
  const n = Math.round(seconds * SR);
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  return Array.from({ length: channels }, (_, c) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      x[i] = 0.3 * Math.sin(2 * Math.PI * (220 + 27 * c) * t) + 0.1 * Math.sin(2 * Math.PI * (660 + 40 * c) * t);
    }
    for (let at = Math.round(0.25 * SR); at < n - 0.1 * SR; at += Math.round(0.5 * SR))
      for (let k = 0; k < 0.005 * SR; k++) x[at + k] = (x[at + k] as number) + 0.8 * Math.exp(-k / (0.001 * SR)) * (k % 2 ? -1 : 1) * (c === 0 ? 1 : 0.7);
    for (let i = Math.round(1.1 * SR); i < Math.round(1.4 * SR); i++) x[i] = (x[i] as number) + 0.2 * rnd() * Math.exp(-(i - 1.1 * SR) / (0.05 * SR));
    return x.map((v) => v * gain);
  });
}

/** FNV-1a over the float bit patterns. */
function hash(chs: readonly Float32Array[]): string {
  let h = 0x811c9dc5;
  for (const c of chs) {
    const u = new Uint32Array(c.buffer, c.byteOffset, c.length);
    for (let i = 0; i < u.length; i++) {
      h ^= u[i] as number;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

describe('WSOLA output, streamed', () => {
  // Hashes of what `timeStretch` made before it was split into a stream (the whole-array version, bit for bit).
  it.each([
    { channels: 2, scale: 0.8, want: 'e31f43c6' },
    { channels: 2, scale: 1.3, want: '26e4f9f8' },
    { channels: 1, scale: 1.3, want: '4b68cce9' },
    { channels: 3, scale: 1.1, want: '98614b7e' },
  ])('is the same audio as before: $channels ch at $scale×', ({ channels, scale, want }) => {
    expect(hash(timeStretch(signal(channels, 3), scale, { sampleRate: SR }))).toBe(want);
  });

  it('hands over every output frame once, in order, a half frame at a time', () => {
    const x = signal(2, 2);
    const outLen = Math.round(x[0]!.length * 1.2);
    let next = 0;
    let biggest = 0;
    stretchStream(x, 1.2, { sampleRate: SR }, (at, chunk, n) => {
      expect(at).toBe(next);
      expect(chunk).toHaveLength(2);
      next += n;
      biggest = Math.max(biggest, n);
    });
    expect(next).toBe(outLen);
    // 20 ms (half of the 40 ms frame): nothing bigger is ever held.
    expect(biggest).toBeLessThanOrEqual(960);
  });
});

describe('stretchToPcm16', () => {
  it('writes the same 16-bit file as quantizing the float output', () => {
    for (const [channels, scale] of [[2, 0.8], [2, 1.3], [1, 1.3], [1, 1]] as const) {
      const x = signal(channels, 2.5);
      const want = encodePcm16(timeStretch(x, scale, { sampleRate: SR }), SR);
      const got = stretchToPcm16(x, scale, { sampleRate: SR });
      expect(got.length, `${channels} ch at ${scale}`).toBe(want.length);
      expect(got, `${channels} ch at ${scale}`).toEqual(want);
    }
  });

  it('keeps audio that goes over full scale unclipped, within one step of the gain of the old file', () => {
    const x = signal(2, 2.5, 3.2);
    const peak = Math.max(...x.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    expect(peak).toBeGreaterThan(1.5);
    const old = decodePcm16(encodePcm16(timeStretch(x, 1.17, { sampleRate: SR }), SR))!;
    const got = decodePcm16(stretchToPcm16(x, 1.17, { sampleRate: SR }))!;
    expect(got.info.frames).toBe(old.info.frames);
    // The gain is the input's peak (the output's peak is never higher), so nothing is clipped.
    expect(got.info.gain).toBeCloseTo(peak, 5);
    expect(got.info.gain).toBeGreaterThanOrEqual(old.info.gain);
    const step = (got.info.gain / 32767) * 1.01;
    let worst = 0;
    got.channels.forEach((c, ch) => c.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - (old.channels[ch]![i] as number))))));
    // Quantizing twice (once at each gain): at most half a step of each.
    expect(worst).toBeLessThanOrEqual(step + old.info.gain / 32767 / 2);
  });

  it('copes with nothing to stretch and with a bad scale', () => {
    expect(decodePcm16(stretchToPcm16([new Float32Array(0)], 1.5, { sampleRate: SR }))!.info.frames).toBe(0);
    expect(() => stretchToPcm16([new Float32Array(10)], 0, { sampleRate: SR })).toThrow(RangeError);
    expect(() => stretchToPcm16([new Float32Array(10)], Number.NaN, { sampleRate: SR })).toThrow(RangeError);
  });
});
