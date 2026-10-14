import { describe, expect, it } from 'vitest';
import { testTransport } from '../testing';
import { LinkwitzRiley } from './crossover';
import { Halfband, halfbandCoefficients, Oversampler } from './halfband';
import { KWeighting, LoudnessMeter } from './loudness';
import { NOTE_LABELS, noteBeats, PhaseClock } from './tempo';
import { TruePeak } from './true-peak';
import { Yin } from './yin';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);

/** Amplitude of the `freq` component of x[from, to) at `rate` (a least-squares sine/cosine fit). */
function amplitude(x: ArrayLike<number>, freq: number, rate: number, from = 0, to = x.length): number {
  let c = 0;
  let s = 0;
  const w = (2 * Math.PI * freq) / rate;
  // Whole cycles, so the fit is exact for a pure tone.
  const cycles = Math.floor(((to - from) * freq) / rate);
  const n = cycles > 0 ? Math.round((cycles * rate) / freq) : to - from;
  for (let i = 0; i < n; i++) {
    const v = x[from + i] as number;
    c += v * Math.cos(w * i);
    s += v * Math.sin(w * i);
  }
  return (2 * Math.hypot(c, s)) / n;
}

const sine = (freq: number, rate: number, amp = 1, phase = 0) => (i: number) =>
  amp * Math.sin((2 * Math.PI * freq * i) / rate + phase);

describe('Halfband / Oversampler', () => {
  it('designs short filters for the usual specs', () => {
    expect(halfbandCoefficients(100, 0.04).length).toBeLessThanOrEqual(12);
    expect(halfbandCoefficients(100, 0.25).length).toBeLessThanOrEqual(5);
    for (const c of halfbandCoefficients(100, 0.04)) expect(c > 0 && c < 1).toBe(true);
  });

  it('upsampling keeps the tone and rejects its image by more than 90 dB', () => {
    const hb = new Halfband(halfbandCoefficients(100, 0.04));
    const x = sine(10000, SR);
    const up = new Float64Array(2 * SR);
    for (let i = 0; i < SR; i++) {
      hb.up(x(i));
      up[2 * i] = hb.even;
      up[2 * i + 1] = hb.odd;
    }
    const from = 4000;
    expect(Math.abs(db(amplitude(up, 10000, 2 * SR, from)))).toBeLessThan(0.01);
    // Zero-stuffing would leave an image at 48 − 10 = 38 kHz.
    expect(db(amplitude(up, 38000, 2 * SR, from))).toBeLessThan(-90);
  });

  it('downsampling rejects what would alias by more than 90 dB', () => {
    const hb = new Halfband(halfbandCoefficients(100, 0.04));
    const high = sine(30000, 2 * SR);
    const pass = sine(9000, 2 * SR);
    const a = new Float64Array(SR);
    const b = new Float64Array(SR);
    for (let i = 0; i < SR; i++) a[i] = hb.down(high(2 * i), high(2 * i + 1));
    hb.reset();
    for (let i = 0; i < SR; i++) b[i] = hb.down(pass(2 * i), pass(2 * i + 1));
    // 30 kHz folds to 18 kHz at 48 kHz.
    expect(db(amplitude(a, 18000, SR, 2000))).toBeLessThan(-90);
    expect(Math.abs(db(amplitude(b, 9000, SR, 2000)))).toBeLessThan(0.01);
  });

  it('a round trip is flat to 20 kHz at 2× and 4×', () => {
    for (const factor of [2, 4] as const) {
      for (const freq of [100, 1000, 10000, 20000]) {
        const os = new Oversampler(factor);
        const x = sine(freq, SR);
        const out = new Float64Array(SR / 2);
        for (let i = 0; i < out.length; i++) {
          os.up(x(i));
          out[i] = os.down();
        }
        expect(Math.abs(db(amplitude(out, freq, SR, 4000))), `${factor}x ${freq} Hz`).toBeLessThan(0.05);
      }
    }
  });

  it('oversampling a clipper cuts the aliasing it makes', () => {
    // An 11 kHz sine clipped hard: at 1× its 3rd harmonic (33 kHz) folds to 15 kHz; at 2× the 7th
    // (77 kHz) folds to 96 − 77 = 19 kHz, which 4× removes too.
    const run = (factor: 1 | 2 | 4) => {
      const os = new Oversampler(factor);
      const x = sine(11000, SR, 2);
      const out = new Float64Array(SR / 2);
      for (let i = 0; i < out.length; i++) {
        os.up(x(i));
        for (let k = 0; k < factor; k++) os.buffer[k] = Math.max(-1, Math.min(1, os.buffer[k] as number));
        out[i] = os.down();
      }
      return (freq: number) => db(amplitude(out, freq, SR, 4000));
    };
    const [x1, x2, x4] = [run(1), run(2), run(4)];
    expect(x1(15000)).toBeGreaterThan(-15);
    expect(x2(15000)).toBeLessThan(x1(15000) - 40);
    expect(x4(15000)).toBeLessThan(x1(15000) - 40);
    expect(x4(19000)).toBeLessThan(x2(19000) - 30);
    // The tone itself comes through at the same level.
    expect(Math.abs(x4(11000) - x1(11000))).toBeLessThan(0.5);
  });
});

describe('LinkwitzRiley', () => {
  it('low + high is exactly the allpass: flat at every frequency', () => {
    const xo = new LinkwitzRiley().set(1000, SR);
    const ap = new LinkwitzRiley().set(1000, SR);
    let worst = 0;
    for (let i = 0; i < 4096; i++) {
      const x = i === 0 ? 1 : 0;
      xo.split(x);
      worst = Math.max(worst, Math.abs(xo.low + xo.high - ap.allpass(x)));
    }
    expect(worst).toBeLessThan(1e-12);
    for (const freq of [50, 500, 1000, 2000, 15000]) {
      const x = new LinkwitzRiley().set(1000, SR);
      const out = new Float64Array(SR / 4);
      const s = sine(freq, SR);
      for (let i = 0; i < out.length; i++) {
        x.split(s(i));
        out[i] = x.low + x.high;
      }
      expect(Math.abs(db(amplitude(out, freq, SR, 4000)))).toBeLessThan(1e-4);
    }
  });

  it('each band is −6 dB at the crossover and falls 24 dB/octave', () => {
    const level = (freq: number, band: 'low' | 'high') => {
      const x = new LinkwitzRiley().set(1000, SR);
      const out = new Float64Array(SR / 4);
      const s = sine(freq, SR);
      for (let i = 0; i < out.length; i++) {
        x.split(s(i));
        out[i] = x[band];
      }
      return db(amplitude(out, freq, SR, 4000));
    };
    expect(level(1000, 'low')).toBeCloseTo(-6.02, 1);
    expect(level(1000, 'high')).toBeCloseTo(-6.02, 1);
    expect(level(4000, 'low')).toBeLessThan(-45);
    expect(level(250, 'high')).toBeLessThan(-45);
    expect(level(100, 'low')).toBeGreaterThan(-0.01);
  });

  it('three bands (the low one phase-aligned) sum flat', () => {
    for (const freq of [40, 200, 800, 3000, 12000]) {
      const a = new LinkwitzRiley().set(200, SR);
      const b = new LinkwitzRiley().set(3000, SR);
      const out = new Float64Array(SR / 4);
      const s = sine(freq, SR);
      for (let i = 0; i < out.length; i++) {
        a.split(s(i));
        b.split(a.high);
        out[i] = b.allpass(a.low) + b.low + b.high;
      }
      expect(Math.abs(db(amplitude(out, freq, SR, 6000))), `${freq} Hz`).toBeLessThan(1e-4);
    }
  });
});

describe('Yin', () => {
  const track = (signal: (i: number) => number, rate = SR, seconds = 0.5, opts = {}) => {
    const yin = new Yin(rate, opts);
    let f = 0;
    for (let i = 0; i < rate * seconds; i++) {
      yin.push(signal(i));
      if (i % 256 === 255) f = yin.detect();
    }
    return { f, confidence: yin.confidence };
  };

  it('finds the pitch of sines, saws and vowel-like tones', () => {
    for (const [freq, rate] of [
      [82.4, SR],
      [220, SR],
      [440, 44100],
      [880, SR],
    ] as const) {
      const { f } = track(sine(freq, rate), rate);
      expect(Math.abs(f / freq - 1), `${freq} Hz sine`).toBeLessThan(0.003);
    }
    // A saw has every harmonic (YIN must not pick an octave).
    const saw = (freq: number) => (i: number) => 2 * ((i * freq) / SR - Math.floor((i * freq) / SR)) - 1;
    expect(Math.abs(track(saw(110)).f / 110 - 1)).toBeLessThan(0.003);
    // A weak fundamental with strong 2nd and 3rd harmonics.
    const vowel = (i: number) =>
      0.3 * Math.sin((2 * Math.PI * 196 * i) / SR) +
      0.8 * Math.sin((2 * Math.PI * 392 * i) / SR) +
      0.6 * Math.sin((2 * Math.PI * 588 * i) / SR);
    const v = track(vowel);
    expect(Math.abs(v.f / 196 - 1)).toBeLessThan(0.003);
    expect(v.confidence).toBeGreaterThan(0.8);
  });

  it('reports no pitch for noise and silence', () => {
    let s = 12345;
    const noise = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 1073741824 - 1;
    };
    expect(track(noise).f).toBe(0);
    expect(track(() => 0).f).toBe(0);
  });
});

describe('TruePeak', () => {
  it('finds the peak between samples (a quarter-rate sine sampled at ±45°)', () => {
    const tp = new TruePeak();
    let peak = 0;
    let samplePeak = 0;
    const x = sine(SR / 4, SR, 1, Math.PI / 4);
    for (let i = 0; i < 4800; i++) {
      const v = x(i);
      samplePeak = Math.max(samplePeak, Math.abs(v));
      const p = tp.process(v);
      if (i > 100) peak = Math.max(peak, p);
    }
    expect(samplePeak).toBeCloseTo(Math.SQRT1_2, 9);
    expect(Math.abs(db(peak))).toBeLessThan(0.1);
  });

  it('reads low tones at their level and includes the samples themselves', () => {
    const tp = new TruePeak();
    let peak = 0;
    const x = sine(997, SR, 0.5);
    for (let i = 0; i < SR / 4; i++) {
      const p = tp.process(x(i));
      if (i > 100) peak = Math.max(peak, p);
    }
    expect(db(peak / 0.5)).toBeCloseTo(0, 2);
    const impulse = new TruePeak();
    const out = Array.from({ length: 32 }, (_, i) => impulse.process(i === 0 ? 0.8 : 0));
    expect(out[TruePeak.LATENCY]).toBeCloseTo(0.8, 9);
    expect(out.every((v) => v <= 0.8 + 1e-9)).toBe(true);
  });
});

describe('LoudnessMeter (BS.1770)', () => {
  it('K-weighting at 48 kHz has the standard’s coefficients', () => {
    // The standard's two biquads, run directly (BS.1770-4, table 1 and 2).
    const pre = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
    const rlb = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };
    const biquad = (c: { b: number[]; a: number[] }) => {
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      return (x: number) => {
        const y = c.b[0]! * x + c.b[1]! * x1 + c.b[2]! * x2 - c.a[0]! * y1 - c.a[1]! * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        return y;
      };
    };
    const f1 = biquad(pre);
    const f2 = biquad(rlb);
    const k = new KWeighting(SR);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i === 0 ? 1 : Math.sin(i * 0.37) * 0.1;
      worst = Math.max(worst, Math.abs(k.process(x) - f2(f1(x))));
    }
    expect(worst).toBeLessThan(1e-8);
  });

  it('a −20 dBFS 1 kHz sine reads −23 LUFS (one channel), −20 LUFS in both', () => {
    const mono = new LoudnessMeter(SR, 1);
    const stereo = new LoudnessMeter(SR, 2);
    const x = sine(1000, SR, 0.1);
    for (let i = 0; i < 5 * SR; i++) {
      mono.process(x(i));
      stereo.process(x(i), x(i));
    }
    for (const v of [mono.momentary, mono.shortTerm, mono.integrated]) expect(v).toBeCloseTo(-23, 1);
    expect(Math.abs(mono.integrated + 23)).toBeLessThan(0.5);
    expect(stereo.integrated).toBeCloseTo(-20, 1);
    expect(new LoudnessMeter(44100, 1).momentary).toBe(-Infinity);
  });

  it('gates silence and passages 10 LU under the rest out of the integrated loudness', () => {
    const m = new LoudnessMeter(SR, 1);
    const loud = sine(1000, SR, 0.1);
    const soft = sine(1000, SR, 0.01);
    for (let i = 0; i < 6 * SR; i++) m.process(loud(i));
    for (let i = 0; i < 6 * SR; i++) m.process(0);
    for (let i = 0; i < 6 * SR; i++) m.process(soft(i));
    expect(m.integrated).toBeCloseTo(-23, 0);
    expect(m.momentary).toBeCloseTo(-43, 0);
    m.resetIntegrated();
    for (let i = 0; i < SR; i++) m.process(soft(i));
    expect(m.integrated).toBeCloseTo(-43, 0);
  });
});

describe('PhaseClock and note lengths', () => {
  it('names note lengths in beats', () => {
    expect(noteBeats('1/4')).toBe(1);
    expect(noteBeats('1/8d')).toBe(0.75);
    expect(noteBeats('1/8t')).toBeCloseTo(1 / 3, 12);
    expect(noteBeats('1 bar')).toBe(4);
    expect(noteBeats('off')).toBe(0);
    expect(NOTE_LABELS['1/16t']).toBe('1/16 triplet');
    expect(NOTE_LABELS['1/4d']).toBe('1/4 dotted');
  });

  it('follows the song while it plays, and runs freely while it is stopped', () => {
    const t = testTransport({ bpm: 120, playing: true, beat: 2.25 });
    const clock = new PhaseClock(SR);
    // One cycle per quarter note: beat 2.25 is a quarter of the way into a cycle.
    expect(clock.next(t, 0, 5, 1)).toBeCloseTo(0.25, 9);
    expect(clock.cycle).toBe(2);
    t.blockStart = SR / 4; // half a beat later at 120 BPM
    expect(clock.next(t, 0, 5, 1)).toBeCloseTo(0.75, 9);
    // Stopped: carries on from where it was, at the synced rate (2 Hz at 120 BPM for a quarter).
    t.playing = false;
    let phase = 0;
    for (let i = 0; i < SR / 8; i++) phase = clock.next(t, i, 5, 1);
    expect(phase).toBeCloseTo(0, 3);
    // Free (no period): the rate in Hz.
    const free = new PhaseClock(SR);
    for (let i = 0; i < SR / 10; i++) phase = free.next(t, i, 2.5);
    expect(phase).toBeCloseTo(0.25, 3);
  });
});
