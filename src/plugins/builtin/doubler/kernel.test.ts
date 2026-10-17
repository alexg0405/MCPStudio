import { describe, expect, it } from 'vitest';
import { rms, runEffect, type TestSignal } from '@agstudio/sdk/testing';
import doubler from './index';
import { DoublerKernel } from './kernel';
import { doublerParams } from './params';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);
const sine = (hz: number, amp: number): TestSignal => (i) => amp * Math.sin((2 * Math.PI * hz * i) / SR);
const PRESETS = [{ name: 'defaults', params: {} }, ...(doubler.presets ?? [])];

function noiseGen(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = i + k + len / 2;
        const xr = (re[b] as number) * wr - (im[b] as number) * wi;
        const xi = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
      }
    }
  }
}

/** Average power spectrum (Welch, Hann, 50 % overlap) of x from frame `from`: N/2 bins. */
function spectrum(x: ArrayLike<number>, from: number, size = 4096): Float64Array {
  const power = new Float64Array(size / 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let frames = 0;
  for (let at = from; at + size <= x.length; at += size / 2) {
    for (let i = 0; i < size; i++) {
      re[i] = (x[at + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) power[k] = (power[k] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    frames++;
  }
  return power.map((v) => v / frames);
}

/** Power ratio (dB) of two spectra averaged over sixth-octave bands from 100 Hz to 12 kHz: [lowest, highest, overall]. */
function bandRatios(num: Float64Array, den: Float64Array, size = 4096): { min: number; max: number } {
  const binHz = SR / size;
  let min = Infinity;
  let max = -Infinity;
  for (let f = 100; f * 2 ** (1 / 6) <= 12000; f *= 2 ** (1 / 6)) {
    let a = 0;
    let b = 0;
    for (let k = Math.floor(f / binHz); k < Math.ceil((f * 2 ** (1 / 6)) / binHz); k++) {
      a += num[k] as number;
      b += den[k] as number;
    }
    const r = 10 * Math.log10(a / b);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  return { min, max };
}

/** A frequency estimate per window from the spacing of rising zero crossings (about ±2 cents at 1 kHz over 200 ms). */
function windowedHz(x: Float32Array, from: number, windowFrames: number): number[] {
  const out: number[] = [];
  for (let at = from; at + windowFrames <= x.length; at += windowFrames) {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let i = at + 1; i < at + windowFrames; i++) {
      const a = x[i - 1] as number;
      const b = x[i] as number;
      if (a < 0 && b >= 0) {
        const pos = i - 1 + -a / (b - a);
        if (first < 0) first = pos;
        last = pos;
        count++;
      }
    }
    if (count > 2) out.push(((count - 1) * SR) / (last - first));
  }
  return out;
}

describe('DoublerKernel', () => {
  it('plays the doubles late by the Delay, one on each side, under the untouched original', () => {
    const impulse: TestSignal = (i) => (i === 1000 ? 1 : 0);
    const params = { voices: 2, delay: 20, spread: 0, drift: 0, width: 1, level: 0, tone: 20000 } as const;
    const [l, r] = runEffect(DoublerKernel, doublerParams, impulse, 4000, { params });
    // The original: exactly the input at frame 1000, on both sides.
    expect(l[1000]).toBe(1);
    expect(r[1000]).toBe(1);
    // Before the doubles arrive, nothing else is there.
    for (let i = 0; i < 1000; i++) expect(l[i]).toBe(0);
    for (let i = 1001; i < 1000 + 960 - 3; i++) expect(Math.abs(l[i] as number)).toBeLessThan(1e-9);
    // Each side has one double, 20 ms (960 frames) after the original.
    const peakAt = (x: Float32Array) => {
      let at = 0;
      for (let i = 1001; i < x.length; i++) if (Math.abs(x[i] as number) > Math.abs(x[at] as number)) at = i;
      return at;
    };
    expect(Math.abs(peakAt(l) - 1960)).toBeLessThanOrEqual(2);
    expect(Math.abs(peakAt(r) - 1960)).toBeLessThanOrEqual(2);
    // At width 100 % voice 1 is on the right only and voice 0 on the left only.
    expect(Math.abs(l[peakAt(l)] as number)).toBeGreaterThan(0.5);
  });

  it('keeps every double within the Pitch drift (cents) and holds the pitch with no drift', () => {
    // Left holds one voice at width 100 %: everything beyond the original is that voice.
    const wet = (drift: number) => {
      const x = sine(1000, 0.3);
      const [l] = runEffect(DoublerKernel, doublerParams, x, SR * 6, {
        params: { voices: 2, delay: 20, spread: 0, drift, width: 1, level: 0, tone: 20000 },
      });
      const out = new Float32Array(l.length);
      for (let i = 0; i < l.length; i++) out[i] = (l[i] as number) - x(i, 0);
      return windowedHz(out, SR, SR / 5).map((hz) => 1731.234 * Math.log(hz / 1000));
    };
    const steady = wet(0);
    expect(Math.max(...steady.map(Math.abs))).toBeLessThan(2.5);
    const drifting = wet(8);
    const peak = Math.max(...drifting.map(Math.abs));
    expect(peak).toBeLessThanOrEqual(8 * 1.1);
    expect(peak).toBeGreaterThan(8 * 0.4);
    // It moves both ways.
    expect(Math.min(...drifting)).toBeLessThan(-2);
    expect(Math.max(...drifting)).toBeGreaterThan(2);
  });

  it('puts all doubles in the middle at 0% width, and apart at 100%', () => {
    const rnd = noiseGen(3);
    const noise = Float32Array.from({ length: SR }, () => 0.3 * rnd());
    const x: TestSignal = (i) => noise[i] as number;
    const run = (width: number) => runEffect(DoublerKernel, doublerParams, x, SR, { params: { width, voices: 4 } });
    const [cl, cr] = run(0);
    for (let i = 0; i < cl.length; i++) expect(cl[i]).toBeCloseTo(cr[i] as number, 6);
    const [wl, wr] = run(1);
    let diff = 0;
    for (let i = 0; i < wl.length; i++) diff = Math.max(diff, Math.abs((wl[i] as number) - (wr[i] as number)));
    expect(diff).toBeGreaterThan(0.1);
  });

  it('keeps a clean mono sum: no deep comb notches, and no loss of level, in any preset', () => {
    const rnd = noiseGen(11);
    const noise = Float32Array.from({ length: SR * 12 }, () => 0.3 * rnd());
    const x: TestSignal = (i) => noise[i] as number;
    const dry = spectrum(noise, SR);
    for (const preset of PRESETS) {
      const [l, r] = runEffect(DoublerKernel, doublerParams, x, noise.length, { params: preset.params as never });
      const mono = Float32Array.from(l, (v, i) => 0.5 * (v + (r[i] as number)));
      // The mono sum of the doubled voice against the voice alone, sixth-octave band by band.
      const { min, max } = bandRatios(spectrum(mono, SR), dry);
      expect(min, `${preset.name}: deepest notch`).toBeGreaterThan(-5);
      expect(max, `${preset.name}: strongest bump`).toBeLessThan(5);
      // Its overall level stays the voice's, to within a dB or two.
      const gain = db(rms(mono, SR) / rms(noise, SR));
      expect(gain, `${preset.name}: mono level`).toBeGreaterThan(-0.5);
      expect(gain, `${preset.name}: mono level`).toBeLessThan(2);
    }
  });

  it('adds only a little to the level of the voice in stereo too', () => {
    const rnd = noiseGen(17);
    const noise = Float32Array.from({ length: SR * 3 }, () => 0.3 * rnd());
    for (const preset of PRESETS) {
      const [l, r] = runEffect(DoublerKernel, doublerParams, (i) => noise[i] as number, noise.length, { params: preset.params as never });
      const out = db(Math.sqrt((rms(l, SR) ** 2 + rms(r, SR) ** 2) / 2) / rms(noise, SR));
      expect(out, preset.name).toBeGreaterThan(0);
      expect(out, preset.name).toBeLessThan(1.5);
    }
  });

  it('adds and drops voices without a click', () => {
    const x = sine(220, 0.4);
    const voices = (frame: number) => (frame < SR / 2 ? 4 : frame < SR ? 2 : 3);
    const [l, r] = runEffect(DoublerKernel, doublerParams, x, SR * 1.5, { params: { voices } });
    // A 220 Hz sine at 0.4 can step at most ~0.03 a frame; with doubles on top, well under 0.1.
    for (const out of [l, r]) {
      let step = 0;
      for (let i = 1; i < out.length; i++) step = Math.max(step, Math.abs((out[i] as number) - (out[i - 1] as number)));
      expect(step).toBeLessThan(0.1);
    }
  });

  it('is deterministic, finite and silent for silence', () => {
    const rnd = noiseGen(23);
    const noise = Float32Array.from({ length: SR }, () => 0.9 * rnd());
    const run = () => runEffect(DoublerKernel, doublerParams, (i) => noise[i] as number, SR, { params: { voices: 4, drift: 15, delay: 50, spread: 1, tone: 2000 } });
    const a = run();
    const b = run();
    expect(a[0].every(Number.isFinite)).toBe(true);
    expect(Buffer.from(a[0].buffer).equals(Buffer.from(b[0].buffer))).toBe(true);
    expect(Buffer.from(a[1].buffer).equals(Buffer.from(b[1].buffer))).toBe(true);
    const [sl] = runEffect(DoublerKernel, doublerParams, () => 0, SR / 2);
    expect(Math.max(...Array.from(sl, Math.abs))).toBe(0);
  });
});
