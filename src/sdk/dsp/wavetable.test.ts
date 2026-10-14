import { describe, expect, it } from 'vitest';
import {
  addPiecewise,
  addSampled,
  WavetableBank,
  WavetableOscillator,
  WT_FRAME_SIZE,
  WT_HARMONICS,
  WT_LEVELS,
  type WavetableSpec,
} from './wavetable';

const SR = 48000;

const saw: WavetableSpec = { name: 'Saw', frame: (_p, sin, cos) => addPiecewise([0, 1, 1, -1], sin, cos) };
const square: WavetableSpec = {
  name: 'Square',
  frame: (_p, sin, cos) => addPiecewise([0, 1, 0.5, 1, 0.5, -1, 1, -1], sin, cos),
};
/** Morphs from a sine (position 0) to a saw (position 1). */
const sineToSaw: WavetableSpec = {
  name: 'Sine to saw',
  frame(p, sin, cos) {
    sin[1] = (sin[1] as number) + (1 - p);
    addPiecewise([0, 1, 1, -1], sin, cos, p * (Math.PI / 2));
  },
};

const bank = WavetableBank.build([saw, square, sineToSaw], 8);

/** In-place radix-2 FFT (test helper). */
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
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    for (let s = 0; s < n; s += size)
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = s + k;
        const b = a + size / 2;
        const tr = (re[b] as number) * wr - (im[b] as number) * wi;
        const ti = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
  }
}

/** Power per bin (Blackman-Harris window). */
function power(x: Float32Array): Float64Array {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / (n - 1);
    const w = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    re[i] = (x[i] as number) * w;
  }
  fft(re, im);
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = (re[k] as number) ** 2 + (im[k] as number) ** 2;
  return p;
}

function render(table: number, position: number, freq: number, n = 16384): Float32Array {
  const osc = new WavetableOscillator(bank);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = osc.next(table, position, freq / SR);
  return out;
}

/** Share of the energy that is not at a harmonic of `freq` (aliasing), in dB. */
function inharmonicDb(x: Float32Array, freq: number): number {
  const p = power(x);
  const n = x.length;
  const binHz = SR / n;
  let total = 0;
  let off = 0;
  for (let k = 1; k < p.length; k++) {
    const hz = k * binHz;
    const h = Math.round(hz / freq);
    const near = h >= 1 && Math.abs(hz - h * freq) <= 8 * binHz;
    total += p[k] as number;
    if (!near) off += p[k] as number;
  }
  return 10 * Math.log10(off / total);
}

describe('WavetableBank', () => {
  it('keeps every mip level below Nyquist and picks the richest level that does', () => {
    for (let key = 0; key <= 135; key += 0.5) {
      const f = 440 * Math.pow(2, (key - 69) / 12);
      const m = WavetableBank.levelFor(f / SR);
      if (m < WT_LEVELS - 1) expect(WavetableBank.harmonics(m) * f).toBeLessThanOrEqual(SR / 2 + 1e-6);
      if (m > 0) expect(WavetableBank.harmonics(m - 1) * f).toBeGreaterThan(SR / 2);
    }
    expect(WavetableBank.levelFor(0)).toBe(0);
    expect(WavetableBank.harmonics(0)).toBe(WT_HARMONICS);
    expect(WavetableBank.harmonics(WT_LEVELS - 1)).toBe(1);
  });

  it('high notes do not alias: what is not a harmonic stays below −60 dB', () => {
    for (const key of [84, 96, 103, 108, 115, 120]) {
      const f = 440 * Math.pow(2, (key - 69) / 12);
      // Measured: −63 dB at C7 (key 84) down to −90 dB at the top of the keyboard.
      for (const table of [0, 1]) expect(inharmonicDb(render(table, 0, f), f)).toBeLessThan(-60);
    }
  });

  it('a note whose second harmonic would pass Nyquist plays a pure sine', () => {
    const f = 13000;
    const p = power(render(0, 0, f));
    const fundamental = Math.round((f / SR) * 16384);
    let rest = 0;
    let total = 0;
    for (let k = 1; k < p.length; k++) {
      total += p[k] as number;
      if (Math.abs(k - fundamental) > 8) rest += p[k] as number;
    }
    expect(10 * Math.log10(rest / total)).toBeLessThan(-60);
  });

  it('a naive saw at the same pitch would alias (the test can see aliasing)', () => {
    const f = 440 * Math.pow(2, (108 - 69) / 12);
    const n = 16384;
    const naive = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      naive[i] = 1 - 2 * ph;
      ph = (ph + f / SR) % 1;
    }
    expect(inharmonicDb(naive, f)).toBeGreaterThan(-30);
  });

  it('normalizes each frame to a peak of 1 and stores a wrap-around sample per level', () => {
    for (let t = 0; t < bank.tables; t++)
      for (let f = 0; f < bank.frames; f++) {
        let peak = 0;
        const o = bank.offset(t, f, 0);
        for (let i = 0; i < WavetableBank.size(0); i++) peak = Math.max(peak, Math.abs(bank.data[o + i] as number));
        expect(peak).toBeCloseTo(1, 6);
        for (let m = 0; m < WT_LEVELS; m++) {
          const at = bank.offset(t, f, m);
          expect(bank.data[at + WavetableBank.size(m)]).toBe(bank.data[at]);
        }
      }
    expect(bank.data.length).toBe(3 * 8 * WT_FRAME_SIZE);
  });

  it('morphs smoothly between frames', () => {
    // Position 0 is the sine; halfway between two frames is the average of both.
    const sine = new Float32Array(64);
    bank.shape(2, 0, sine, 3);
    for (let i = 0; i < 64; i++) expect(sine[i]).toBeCloseTo(Math.sin((2 * Math.PI * i) / 64), 3);
    const a = new Float32Array(64);
    const b = new Float32Array(64);
    const mid = new Float32Array(64);
    bank.shape(2, 3 / 7, a, 0);
    bank.shape(2, 4 / 7, b, 0);
    bank.shape(2, 3.5 / 7, mid, 0);
    for (let i = 0; i < 64; i++) expect(mid[i]).toBeCloseTo(((a[i] as number) + (b[i] as number)) / 2, 6);
  });

  it('wraps data built elsewhere (what a kernel receives)', () => {
    const copy = WavetableBank.wrap(bank.data.slice(), bank.tables, bank.frames);
    expect(copy.sample(1, 0.3, 0.123, 2)).toBe(bank.sample(1, 0.3, 0.123, 2));
    expect(() => WavetableBank.wrap(new Float32Array(10), 1, 1)).toThrow();
  });
});

describe('Fourier series of drawn shapes', () => {
  it('addPiecewise gives the exact series of a falling saw, a square and a triangle', () => {
    const sin = new Float64Array(33);
    const cos = new Float64Array(33);
    addPiecewise([0, 1, 1, -1], sin, cos);
    for (let k = 1; k <= 32; k++) {
      expect(sin[k]).toBeCloseTo(2 / (Math.PI * k), 9);
      expect(cos[k]).toBeCloseTo(0, 9);
    }
    sin.fill(0);
    cos.fill(0);
    addPiecewise([0, 1, 0.5, 1, 0.5, -1, 1, -1], sin, cos);
    for (let k = 1; k <= 32; k++) expect(sin[k]).toBeCloseTo(k % 2 ? 4 / (Math.PI * k) : 0, 9);
    sin.fill(0);
    cos.fill(0);
    addPiecewise([0, 0, 0.25, 1, 0.75, -1, 1, 0], sin, cos);
    // A triangle peaking at t = 1/4: (8/π²) Σ odd k (−1)^((k−1)/2) sin(2πkt) / k².
    for (let k = 1; k <= 32; k++) {
      const sign = ((k - 1) / 2) % 2 === 0 ? 1 : -1;
      expect(sin[k]).toBeCloseTo(k % 2 ? (sign * 8) / (Math.PI * Math.PI * k * k) : 0, 9);
      expect(cos[k]).toBeCloseTo(0, 9);
    }
  });

  it('addSampled matches the series of a smooth shape', () => {
    const sin = new Float64Array(17);
    const cos = new Float64Array(17);
    addSampled((t) => 0.5 * Math.cos(2 * Math.PI * 3 * t) + Math.sin(2 * Math.PI * t), sin, cos);
    expect(sin[1]).toBeCloseTo(1, 9);
    expect(cos[3]).toBeCloseTo(0.5, 9);
    for (let k = 1; k <= 16; k++) if (k !== 1) expect(sin[k]).toBeCloseTo(0, 9);
  });
});
