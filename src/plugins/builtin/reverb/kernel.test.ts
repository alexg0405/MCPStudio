import { describe, expect, it } from 'vitest';
import { descriptors, encode, messageParamNames, type ParamSpec, type ParamValue } from '@agstudio/sdk/params';
import { cpuNow, paramBlock, runEffect, settle, testHost } from '@agstudio/sdk/testing';
import { Biquad, KernelRunner } from '@agstudio/sdk/worklet';
import { ReverbKernel } from './kernel';
import { reverbParams } from './params';
import { generateReverbIR } from './ir.kernel';
import reverb from './index';

const SR = 48000;
const impulse = (i: number) => (i === 0 ? 1 : 0);
const wet = { mix: 1, preDelay: 0 } as const;

/** RT60 from the Schroeder energy decay curve: the −5 → −35 dB slope (T30), extrapolated to 60 dB. */
function rt60(x: Float32Array): number {
  const edc = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) {
    acc += (x[i] as number) ** 2;
    edc[i] = acc;
  }
  const db = (i: number) => 10 * Math.log10((edc[i] as number) / (edc[0] as number));
  let from = -1;
  for (let i = 0; i < x.length; i++) {
    if (from < 0 && db(i) <= -5) from = i;
    if (db(i) <= -35) return ((i - from) / SR) * 2;
  }
  return Infinity;
}

const energy = (x: Float32Array, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += (x[i] as number) ** 2;
  return e;
};

/**
 * Normalized echo density (Abel & Huang): the share of samples more than one standard deviation
 * from zero in a window, over what Gaussian noise has (erfc(1/√2)). About 1 for a diffuse tail,
 * well under 1 for sparse echoes (flutter).
 */
function echoDensity(x: Float32Array, from: number, length: number): number {
  const s = Math.sqrt(energy(x, from, from + length) / length);
  let outside = 0;
  for (let i = from; i < from + length; i++) if (Math.abs(x[i] as number) > s) outside++;
  return outside / length / 0.3173;
}

/** Power spectrum (Hann window) of x[from, from + 2^bits). */
function powerSpectrum(x: Float32Array, from: number, bits: number, hann = true): Float64Array {
  const n = 1 << bits;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (hann ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n) : 1);
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
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * wr - (im[b] as number) * wi;
        const xi = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
      }
  }
  const out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) out[k] = (re[k] as number) ** 2 + (im[k] as number) ** 2;
  return out;
}

/** x through a 500 Hz – 4 kHz band-pass (two 2nd-order high-passes, two low-passes): the mids. */
function mids(x: Float32Array): Float32Array {
  const f = [
    new Biquad().set('highpass', 500, 0.707, SR),
    new Biquad().set('highpass', 500, 0.707, SR),
    new Biquad().set('lowpass', 4000, 0.707, SR),
    new Biquad().set('lowpass', 4000, 0.707, SR),
  ];
  return x.map((v) => f.reduce((y, b) => b.process(y), v));
}

/** Energy of x between lo and hi Hz (zero-padded FFT, no window). */
function bandEnergy(x: Float32Array, lo: number, hi: number): number {
  let bits = 10;
  while (1 << bits < x.length) bits++;
  const spec = powerSpectrum(x, 0, bits, false);
  const hz = SR / (1 << bits);
  let e = 0;
  for (let k = Math.round(lo / hz); k < Math.round(hi / hz); k++) e += spec[k] as number;
  return e;
}

const maxAbsDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);

describe('ReverbKernel (algorithmic engine)', () => {
  it('decays in the RT60 asked for (±20 %, from the energy decay curve)', () => {
    const rows: string[] = [];
    for (const decay of [1, 3, 7])
      for (const damping of [0, 0.5])
        for (const size of [0.2, 0.6, 1]) {
          const [l, r] = runEffect(ReverbKernel, reverbParams, impulse, Math.round((decay * 1.3 + 0.3) * SR), {
            params: { ...wet, decay, damping, size },
          });
          for (const ch of [l, r]) {
            // Decay is the mids' RT60 (the lows ring a little longer, Damping shortens the highs).
            const measured = rt60(mids(ch));
            rows.push(`decay ${decay} s, damping ${damping}, size ${size}: ${measured.toFixed(2)} s`);
            expect(measured, rows.at(-1)).toBeGreaterThan(decay * 0.8);
            expect(measured, rows.at(-1)).toBeLessThan(decay * 1.2);
          }
        }
  });

  it('Decay changes the length, not the loudness (unit energy, like the convolution IR)', () => {
    for (const decay of [0.3, 2, 7])
      for (const size of [0, 1])
        for (const damping of [0, 0.5, 1]) {
          const [l, r] = runEffect(ReverbKernel, reverbParams, impulse, Math.round((decay * 2.2 + 0.3) * SR), {
            params: { ...wet, decay, damping, size },
          });
          for (const e of [energy(l), energy(r)]) {
            expect(e, `decay ${decay}, size ${size}, damping ${damping}`).toBeGreaterThan(0.8);
            expect(e, `decay ${decay}, size ${size}, damping ${damping}`).toBeLessThan(1.25);
          }
        }
  });

  it('sounds like the convolution engine: every band within 3 dB of its energy', () => {
    for (const damping of [0, 0.5, 1])
      for (const decay of [0.8, 2.5]) {
        const opts = { decay, damping, size: 0.6 };
        const [ir] = generateReverbIR({ sampleRate: SR, ...opts });
        const [l] = runEffect(ReverbKernel, reverbParams, impulse, ir.length, { params: { ...wet, ...opts } });
        for (const [lo, hi] of [
          [20, 250],
          [250, 1000],
          [1000, 4000],
          [4000, 10000],
          [10000, 20000],
        ] as const) {
          const db = 10 * Math.log10(bandEnergy(l, lo, hi) / bandEnergy(ir, lo, hi));
          expect(Math.abs(db), `${JSON.stringify(opts)}, ${lo}–${hi} Hz: ${db.toFixed(1)} dB`).toBeLessThan(3);
        }
      }
  }, 90_000); // six 1–3 s renders through both engines: slow on a busy machine

  it('left and right are decorrelated', () => {
    for (const size of [0, 0.6, 1]) {
      const [l, r] = runEffect(ReverbKernel, reverbParams, impulse, SR * 3, { params: { ...wet, size } });
      let lr = 0;
      for (let i = 0; i < l.length; i++) lr += (l[i] as number) * (r[i] as number);
      expect(Math.abs(lr / Math.sqrt(energy(l) * energy(r))), `size ${size}`).toBeLessThan(0.1);
    }
  });

  it('builds a dense, smooth tail: Gaussian-like echo density, no dominant modes', () => {
    for (const p of [
      { decay: 2.2, size: 0.6, damping: 0.5 },
      { decay: 7, size: 1, damping: 0 },
      { decay: 0.8, size: 0.1, damping: 0.6 },
    ]) {
      const [l] = runEffect(ReverbKernel, reverbParams, impulse, SR * 2, { params: { ...wet, ...p } });
      // Dense from 0.1 s on (20 ms windows): no sparse echoes, no flutter.
      const win = Math.round(0.02 * SR);
      for (let t = 0.1; t < 1.5; t += 0.02) {
        const d = echoDensity(l, Math.round(t * SR), win);
        expect(d, `${JSON.stringify(p)} at ${t.toFixed(2)} s`).toBeGreaterThan(0.8);
      }
      // The tail's spectrum (0.15 s on, the decay taken out so every bin resolves): in each
      // third-octave band from 500 Hz to 10 kHz the loudest bin stands at most 13 dB over the band's
      // mean and the loudest tenth of the bins hold at most 55 % of its energy (42 % on average). The
      // convolution engine's noise tail measures about 10 dB and 38 %; without its modulation this
      // reverb measures 14–17 dB and up to 59–75 % (a few modes ringing out).
      const bits = 15;
      const t0 = Math.round(0.15 * SR);
      const flat = Float32Array.from(
        { length: 1 << bits },
        (_, i) => (l[t0 + i] as number) * Math.exp((6.91 * i) / SR / p.decay),
      );
      const spec = powerSpectrum(flat, 0, bits);
      const hz = SR / (1 << bits);
      const shares: number[] = [];
      for (let f = 500; f < 10000; f *= Math.cbrt(2)) {
        const bins = Array.from(spec.subarray(Math.round(f / hz), Math.round((f * Math.cbrt(2)) / hz))).sort(
          (x, y) => y - x,
        );
        const total = bins.reduce((x, y) => x + y, 0);
        const top = bins.slice(0, Math.round(bins.length / 10)).reduce((x, y) => x + y, 0);
        const at = `${JSON.stringify(p)} at ${Math.round(f)} Hz`;
        expect(10 * Math.log10(((bins[0] as number) * bins.length) / total), at).toBeLessThan(13);
        expect(top / total, at).toBeLessThan(0.55);
        shares.push(top / total);
      }
      expect(shares.reduce((x, y) => x + y, 0) / shares.length).toBeLessThan(0.42);
    }
  });

  it('is silence after silence: the tail ends, the network idles and the SDK runner sleeps', () => {
    const kernel = new ReverbKernel(testHost(SR));
    const names = descriptors(reverbParams).map((d) => d.name);
    const values: Record<string, ParamValue> = { decay: 3, preDelay: 0.05, mix: 0.4 };
    const spec = (k: string) => reverbParams[k as keyof typeof reverbParams] as ParamSpec;
    const message = messageParamNames(reverbParams).map(
      (k) => [k, encode(spec(k), values[k] ?? spec(k).default)] as const,
    );
    const runner = new KernelRunner(kernel, () => {}, names, message);
    const audio: Record<string, Float32Array> = {};
    for (const k of names) audio[k] = new Float32Array([encode(spec(k), values[k] ?? spec(k).default)]);
    const inL = new Float32Array(128);
    const inR = new Float32Array(128);
    const out = [new Float32Array(128), new Float32Array(128)];
    let asleepAt = -1;
    let lastSound = 0;
    for (let b = 0; b < (12 * SR) / 128; b++) {
      // Half a second of noise, then silence.
      for (let i = 0; i < 128; i++) {
        const t = b * 128 + i;
        inL[i] = t < SR / 2 ? Math.sin(t * 0.37) * Math.sin(t * 0.0021) * 0.5 : 0;
        inR[i] = t < SR / 2 ? Math.sin(t * 0.29) * Math.sin(t * 0.0017) * 0.5 : 0;
      }
      runner.process([[inL, inR]], [out], audio, b * 128);
      if (out[0]!.some((x) => x !== 0) || out[1]!.some((x) => x !== 0)) lastSound = (b + 1) * 128;
      if (runner.asleep && asleepAt < 0) asleepAt = b * 128;
    }
    // The tail rings for its RT60 and more (−60 dB at 0.5 + 3 s), then stops dead.
    expect(lastSound / SR).toBeGreaterThan(3.5);
    expect(lastSound / SR).toBeLessThan(0.5 + 3 * (100 / 60) + 1);
    // The runner sleeps a second after the last sound and stays asleep.
    expect(asleepAt).toBeGreaterThan(0);
    expect((asleepAt - lastSound) / SR).toBeLessThan(1.1);
    expect(runner.asleep).toBe(true);
  });

  it('is deterministic, whatever the block size', () => {
    const noise = (i: number, c: number) => Math.sin(i * (c ? 0.031 : 0.023)) * Math.sin(i * 0.0007) * 0.5;
    const params = { decay: 4, size: 0.8, damping: 0.3, mix: 0.5 };
    const [a] = runEffect(ReverbKernel, reverbParams, noise, SR, { params });
    const [b] = runEffect(ReverbKernel, reverbParams, noise, SR, { params });
    const [c] = runEffect(ReverbKernel, reverbParams, noise, SR, { params, block: 37 });
    expect(maxAbsDiff(a, b)).toBe(0);
    expect(maxAbsDiff(a, c)).toBe(0);
  });

  it('never makes NaN or runaway levels, at every preset and at the extremes', () => {
    // A second of loud noise (deterministic), then the tail.
    let seed = 1;
    const loud = (i: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return i < SR ? (seed / 2 ** 32 - 0.5) * 1.6 : 0;
    };
    const settings = [
      ...(reverb.presets ?? []).map((p) => p.params ?? {}),
      { decay: 10, size: 1, damping: 0, preDelay: 0.2, mix: 1 },
      { decay: 0.2, size: 0, damping: 1, preDelay: 0, mix: 1 },
      { decay: 10, size: 0, damping: 1, mix: 1 },
    ];
    for (const params of settings) {
      const [l, r] = runEffect(ReverbKernel, reverbParams, loud, SR * 2, { params });
      for (const ch of [l, r]) {
        expect(ch.every(Number.isFinite)).toBe(true);
        // Unit energy: noise peaking at 0.8 comes out at about the same level (peaks a little higher).
        expect(Math.max(...Array.from(ch, Math.abs)), JSON.stringify(params)).toBeLessThan(3);
      }
    }
    // A NaN in the input is cleared by reset() (the SDK runner calls it when it scrubs a block).
    const k = new ReverbKernel(testHost(SR));
    runEffect(k, reverbParams, (i) => (i === 100 ? NaN : 0), 1024, { params: wet });
    k.reset();
    const [after] = runEffect(k, reverbParams, impulse, SR, { params: wet });
    expect(after.every(Number.isFinite)).toBe(true);
    expect(energy(after)).toBeGreaterThan(0.3);
  });

  it('glides when the knobs move: no clicks', () => {
    // Low tones through the reverb have nothing above 4 kHz; a click (a jump in a delay, a gain or a
    // filter) would show up there as a burst. The tone runs on across the knob moves.
    let start = 0;
    const tone = (i: number, c: number) => 0.5 * Math.sin((2 * Math.PI * (c ? 110 : 90) * (start + i)) / SR);
    const ease = (t: number) => (t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t));
    const k = new ReverbKernel(testHost(SR));
    const hp = [0, 1].map(() => [
      new Biquad().set('highpass', 4000, 0.707, SR),
      new Biquad().set('highpass', 4000, 0.707, SR),
    ]);
    const burst = ([l, r]: Float32Array[], from = 0) => {
      let m = 0;
      [l, r].forEach((ch, c) => {
        for (let i = 0; i < ch!.length; i++) {
          const y = hp[c]!.reduce((v, f) => f.process(v), ch![i] as number);
          if (i >= from) m = Math.max(m, Math.abs(y));
        }
      });
      return m;
    };
    const steady = burst(
      runEffect(k, reverbParams, tone, SR, { params: { decay: 2, size: 0.4, damping: 0.5, mix: 0.7 } }),
      SR / 2,
    );
    start = SR;
    const rows = [`steady: ${steady.toExponential(1)}`];
    for (const params of [
      { decay: 8, size: 0.4, damping: 0.5, mix: 0.7 },
      { decay: 8, size: 1, damping: 0.5, mix: 0.7 },
      { decay: 8, size: 1, damping: 0, mix: 0.7 },
      { decay: 0.3, size: 0, damping: 1, mix: 0.7 },
      // Mix and Pre-delay are a-rate: they follow their automation (here, smooth 20 ms and 250 ms moves).
      { decay: 0.3, size: 0, damping: 1, mix: (i: number) => 0.7 - 0.5 * ease(i / (0.02 * SR)) },
      { decay: 0.3, size: 0, damping: 1, mix: 0.2, preDelay: (i: number) => 0.02 + 0.05 * ease(i / (0.25 * SR)) },
    ]) {
      const hf = burst(runEffect(k, reverbParams, tone, SR / 2, { params }));
      start += SR / 2;
      rows.push(`${JSON.stringify(params).replace(/,?"\w+":null/g, '')}: ${hf.toExponential(1)}`);
      // At least 54 dB under the tone, even for these preset-sized jumps (without the smoothing,
      // the first one alone measures 5.6e-3).
      expect(hf, rows.join('\n')).toBeLessThan(1e-3);
    }
  });

  it('pre-delay holds the reverb back; 0 % mix is the input untouched', () => {
    const [l] = runEffect(ReverbKernel, reverbParams, impulse, SR, { params: { mix: 1, preDelay: 0.1 } });
    expect(energy(l, 0, Math.round(0.1 * SR))).toBeLessThan(1e-20);
    expect(energy(l, Math.round(0.1 * SR))).toBeGreaterThan(0.5);
    const signal = (i: number, c: number) => Math.sin(i * (c ? 0.05 : 0.07)) * 0.5;
    const [dl, dr] = runEffect(ReverbKernel, reverbParams, signal, SR / 4, { params: { mix: 0 } });
    for (let i = 0; i < dl.length; i++) {
      expect(dl[i]).toBe(Math.fround(signal(i, 0)));
      expect(dr[i]).toBe(Math.fround(signal(i, 1)));
    }
  });

  it('costs well under 1 % of a core at 48 kHz, at any decay (10 s of stereo audio)', async () => {
    const rows: string[] = [];
    for (const decay of [0.5, 7]) {
      const k = new ReverbKernel(testHost(SR));
      const p = paramBlock(reverbParams, { decay, size: 1 });
      const inL = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.1) * 0.3);
      const inR = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.13) * 0.3);
      const input = [inL, inR];
      const output = [new Float32Array(128), new Float32Array(128)];
      const run = (seconds: number) => {
        for (let f = 0; f < seconds * SR; f += 128) k.process(input, output, 128, p);
      };
      run(2); // warm up the JIT
      // 10 s of audio, timed by the CPU time this process spends (not the wall clock: the whole
      // suite runs in parallel and a busy machine would only add time spent waiting for a core).
      // Five 2 s runs, each at its best of two, so a hiccup (GC, another thread) can't fail it; and the
      // whole measurement is repeated (up to 4 times, stopping at the first that is cheap enough) because
      // CPU time too grows a little when every core is busy.
      const measure = () => {
        let sum = 0;
        for (let j = 0; j < 5; j++) {
          let best = Infinity;
          for (let t = 0; t < 2; t++) {
            const t0 = cpuNow();
            run(2);
            best = Math.min(best, cpuNow() - t0);
          }
          sum += best;
        }
        return sum;
      };
      const total = await settle(measure, (ms) => (ms / 10_000) * 100 < 1);
      const share = (total / 10_000) * 100;
      rows.push(`decay ${decay} s: ${share.toFixed(3)} % of a core`);
      // Measured on an M-series Mac: about 0.3 %. The limit leaves room for a busy CI machine.
      expect(share, rows.at(-1)).toBeLessThan(1);
    }
    console.log(`Reverb (algorithmic) cost per instance at 48 kHz:\n${rows.join('\n')}`);
  });
});
