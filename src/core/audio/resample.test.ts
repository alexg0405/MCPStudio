import { describe, expect, it } from 'vitest';
import { Resampler } from './resample';

const tone = (hz: number, rate: number, n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * (i + from)) / rate));

/** Error of `out` against a tone at the output rate, in dB relative to the tone, ignoring the edges. */
function errDb(out: Float32Array, hz: number, dstRate: number, start: number, skip = 200): number {
  let e = 0;
  let s = 0;
  for (let i = skip; i < out.length - skip; i++) {
    const ref = 0.5 * Math.sin((2 * Math.PI * hz * (i + start)) / dstRate);
    e += (out[i]! - ref) ** 2;
    s += ref * ref;
  }
  return 10 * Math.log10(e / s);
}

describe('Resampler', () => {
  it('converts 44.1 kHz to 48 kHz with an error under −70 dB (up to 18 kHz)', () => {
    const r = new Resampler(44100, 48000);
    for (const hz of [440, 3000, 12000, 18000]) {
      const n = 6000;
      const { from, to } = r.need(0, n);
      const src = tone(hz, 44100, to - from, from);
      const out = new Float32Array(n);
      r.convert(src, from, out, 0, n);
      expect(errDb(out, hz, 48000, 0)).toBeLessThan(-70);
    }
  });

  it('thins 96 kHz to 48 kHz and keeps what is above the new Nyquist out', () => {
    const r = new Resampler(96000, 48000);
    const n = 4000;
    const { from, to } = r.need(0, n);
    const keep = new Float32Array(n);
    r.convert(tone(5000, 96000, to - from, from), from, keep, 0, n);
    expect(errDb(keep, 5000, 48000, 0)).toBeLessThan(-70);
    const alias = new Float32Array(n);
    r.convert(tone(30000, 96000, to - from, from), from, alias, 0, n);
    let rms = 0;
    for (let i = 300; i < n - 300; i++) rms += alias[i]! ** 2;
    rms = Math.sqrt(rms / (n - 600));
    // A tone of 0.5 would be 0.35 RMS; 30 kHz must be gone.
    expect(20 * Math.log10(rms / 0.354)).toBeLessThan(-60);
  });

  it('gives the same samples whether it converts a stretch whole or in pieces (no seam)', () => {
    const r = new Resampler(44100, 48000);
    const total = 70000;
    const { from, to } = r.need(100000, total);
    const src = tone(1234, 44100, to - from, from);
    const whole = new Float32Array(total);
    r.convert(src, from, whole, 100000, total);
    const pieces = new Float32Array(total);
    for (let o = 0; o < total; o += 65536) {
      const n = Math.min(65536, total - o);
      const need = r.need(100000 + o, n);
      const part = new Float32Array(n);
      r.convert(src.subarray(need.from - from, need.to - from), need.from, part, 100000 + o, n);
      pieces.set(part, o);
    }
    expect(Buffer.from(pieces.buffer).equals(Buffer.from(whole.buffer))).toBe(true);
  });

  it('has unit gain at DC and reads zeros outside the source it is given', () => {
    const r = new Resampler(44100, 48000);
    const n = 2000;
    const { from, to } = r.need(0, n);
    const out = new Float32Array(n);
    r.convert(new Float32Array(to - from).fill(0.5), from, out, 0, n);
    for (let i = 100; i < n - 100; i++) expect(out[i]).toBeCloseTo(0.5, 4);
    const edge = new Float32Array(10);
    r.convert(new Float32Array(0), 0, edge, 0, 10);
    expect(edge.every((v) => v === 0)).toBe(true);
  });
});
