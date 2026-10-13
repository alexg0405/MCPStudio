import { describe, expect, it } from 'vitest';
import { FFT, RealFFT, hannWindow, isPowerOfTwo, magnitudeSpectrum, nextPowerOfTwo } from './fft';
import { mulberry32 } from './test-signals';

function naiveDft(re: ArrayLike<number>, im: ArrayLike<number>, sign = -1): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const a = (sign * 2 * Math.PI * k * t) / n;
      const xr = re[t] as number;
      const xi = im[t] as number;
      sr += xr * Math.cos(a) - xi * Math.sin(a);
      si += xr * Math.sin(a) + xi * Math.cos(a);
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function randomArray(n: number, seed: number): Float64Array {
  const rand = mulberry32(seed);
  return Float64Array.from({ length: n }, () => rand() * 2 - 1);
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>, n = a.length): number {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}

describe('fft helpers', () => {
  it('recognizes and rounds up to powers of two', () => {
    expect([1, 2, 4, 1024].every(isPowerOfTwo)).toBe(true);
    expect([0, 3, 6, 1000, 2.5, -4].some(isPowerOfTwo)).toBe(false);
    expect([0, 1, 2, 3, 5, 1000, 1024, 1025].map(nextPowerOfTwo)).toEqual([1, 1, 2, 4, 8, 1024, 1024, 2048]);
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(12)).toThrow(RangeError);
    expect(() => new RealFFT(1)).toThrow(RangeError);
    expect(() => new RealFFT(48)).toThrow(RangeError);
  });
});

describe('FFT (complex)', () => {
  it.each([1, 2, 4, 8, 16, 64, 256, 1024])('matches a naive DFT at size %i', (n) => {
    const re = randomArray(n, n);
    const im = randomArray(n, n + 1);
    const want = naiveDft(re, im);
    const fft = new FFT(n);
    fft.forward(re, im);
    expect(maxDiff(re, want.re)).toBeLessThan(1e-9 * n);
    expect(maxDiff(im, want.im)).toBeLessThan(1e-9 * n);
  });

  it('inverse undoes forward', () => {
    const n = 512;
    const re = randomArray(n, 7);
    const im = randomArray(n, 8);
    const re0 = re.slice();
    const im0 = im.slice();
    const fft = new FFT(n);
    fft.forward(re, im);
    fft.inverse(re, im);
    expect(maxDiff(re, re0)).toBeLessThan(1e-12);
    expect(maxDiff(im, im0)).toBeLessThan(1e-12);
  });
});

describe('RealFFT', () => {
  it.each([2, 4, 8, 32, 128, 1024, 4096])('matches a naive DFT at size %i', (n) => {
    const x = randomArray(n, 100 + n);
    const want = naiveDft(x, new Float64Array(n));
    const fft = new RealFFT(n);
    const re = new Float64Array(fft.bins);
    const im = new Float64Array(fft.bins);
    fft.forward(x, re, im);
    expect(fft.bins).toBe(n / 2 + 1);
    expect(maxDiff(re, want.re, fft.bins)).toBeLessThan(1e-9 * n);
    expect(maxDiff(im, want.im, fft.bins)).toBeLessThan(1e-9 * n);
  });

  it.each([2, 16, 1024])('inverse undoes forward at size %i', (n) => {
    const x = randomArray(n, 3 * n);
    const fft = new RealFFT(n);
    const re = new Float64Array(fft.bins);
    const im = new Float64Array(fft.bins);
    fft.forward(x, re, im);
    const back = new Float64Array(n);
    fft.inverse(re, im, back);
    expect(maxDiff(back, x)).toBeLessThan(1e-12);
  });

  it('computes a circular cross-correlation through the spectrum', () => {
    const n = 64;
    const a = randomArray(n, 1);
    const b = randomArray(n, 2);
    const fft = new RealFFT(n);
    const [ar, ai, br, bi] = [0, 0, 0, 0].map(() => new Float64Array(fft.bins)) as [
      Float64Array,
      Float64Array,
      Float64Array,
      Float64Array,
    ];
    fft.forward(a, ar, ai);
    fft.forward(b, br, bi);
    for (let k = 0; k < fft.bins; k++) {
      const [xr, xi, yr, yi] = [ar[k], ai[k], br[k], bi[k]] as number[] as [number, number, number, number];
      ar[k] = xr * yr + xi * yi;
      ai[k] = xr * yi - xi * yr;
    }
    const r = new Float64Array(n);
    fft.inverse(ar, ai, r);
    for (const lag of [0, 1, 5, 63]) {
      let want = 0;
      for (let j = 0; j < n; j++) want += (a[j] as number) * (b[(j + lag) % n] as number);
      expect(r[lag]).toBeCloseTo(want, 9);
    }
  });
});

describe('windows and spectra', () => {
  it('builds periodic and symmetric Hann windows', () => {
    const p = hannWindow(8);
    expect(p[0]).toBe(0);
    expect(p[4]).toBeCloseTo(1, 12);
    expect(p[1]).toBeCloseTo(p[7] as number, 12);
    const s = hannWindow(9, true);
    expect(s[0]).toBe(0);
    expect(s[8]).toBeCloseTo(0, 12);
    expect(s[4]).toBeCloseTo(1, 12);
    expect(hannWindow(1)[0]).toBe(1);
    expect(hannWindow(0).length).toBe(0);
  });

  it('puts a windowed sine in its bin and handles frames hanging over the ends', () => {
    const n = 1024;
    const sr = 48000;
    const bin = 37;
    const x = Float32Array.from({ length: 4 * n }, (_, i) => Math.sin((2 * Math.PI * bin * sr * i) / n / sr));
    const fft = new RealFFT(n);
    const w = hannWindow(n);
    const mag = new Float32Array(fft.bins);
    magnitudeSpectrum(fft, x, n, w, mag);
    let peak = 0;
    for (let k = 1; k < mag.length; k++) if ((mag[k] as number) > (mag[peak] as number)) peak = k;
    expect(peak).toBe(bin);
    // Hann: the sine's peak bin holds amplitude × N / 4.
    expect(mag[bin]).toBeCloseTo(n / 4, 1);
    expect(mag[bin + 1]).toBeCloseTo(n / 8, 1);
    expect(mag[bin + 3]).toBeLessThan(1e-3);

    const power = new Float64Array(fft.bins);
    magnitudeSpectrum(fft, x, n, w, power, true);
    expect(power[bin]).toBeCloseTo((n / 4) ** 2, -1);

    // Half the frame before the start: zeros there, so the energy halves (roughly).
    magnitudeSpectrum(fft, x, -n / 2, w, mag);
    expect(mag[bin]).toBeGreaterThan(n / 16);
    expect(mag[bin]).toBeLessThan(n / 4);
    magnitudeSpectrum(fft, x, 10 * n, w, mag);
    expect(Math.max(...mag)).toBe(0);
  });
});
