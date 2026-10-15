/**
 * Procedural transition sounds (see `core/model/fx.ts`): pure functions of the sample name and rate,
 * seeded from the name, so every render is identical and nothing is downloaded.
 * - riser: noise through a band-pass sweeping 300 Hz → 9 kHz plus detuned saws gliding up two
 *   octaves, swelling from −30 dB to full level at its very end (the downbeat);
 * - downlifter: the reverse movement, falling and fading out;
 * - reverse crash: a crash played backwards, so its peak lands on the end;
 * - whoosh: a band-pass sweep up and down that swells and fades;
 * - impact: a deep boom with a crack and a long noisy tail, its peak in the first milliseconds;
 * - sub drop: a sine falling from 65 to 28 Hz.
 * Risers, downlifters, reverse crashes and whooshes are high-passed at 150 Hz: the lows before a
 * drop belong to the gap. Never change a published FX_VERSION's output.
 */
import { fxSeconds, parseFxName, type FxKind } from '@core/model/fx';
import { Biquad } from '@agstudio/sdk/dsp/biquad';
import { Rng } from '@agstudio/sdk/dsp/random';

const TAU = Math.PI * 2;
/** Filter coefficients follow a sweep every this many samples. */
const CONTROL = 32;

function seedOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const db = (v: number) => Math.pow(10, v / 20);

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Scales to `peak` and fades the first `fadeIn` and last `fadeOut` seconds (no clicks). */
function finish(chs: Float32Array[], sr: number, peak: number, fadeIn: number, fadeOut: number): Float32Array[] {
  let max = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i]!));
  const g = max > 0 ? peak / max : 0;
  const a = Math.max(1, Math.round(fadeIn * sr));
  const b = Math.max(1, Math.round(fadeOut * sr));
  for (const ch of chs) {
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      let v = ch[i]! * g;
      if (i < a) v *= i / a;
      const fromEnd = n - 1 - i;
      if (fromEnd < b) v *= fromEnd / b;
      ch[i] = v;
    }
  }
  return chs;
}

/** Noise through a band-pass whose centre follows `centre(x)` (x = 0…1 through the sound), per channel. */
function sweptNoise(n: number, sr: number, seed: number, centre: (x: number) => number, q: number): Float32Array[] {
  return [0, 1].map((c) => {
    const rng = new Rng(seed + c * 7919);
    const bp = new Biquad();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i % CONTROL === 0) bp.set('bandpass', centre(i / n), q, sr);
      out[i] = bp.process(rng.bipolar());
    }
    return out;
  });
}

/** Three detuned PolyBLEP saws gliding along `freq(x)`, the outer ones panned apart. */
function saws(n: number, sr: number, freq: (x: number) => number): Float32Array[] {
  const detune = [-0.11, 0, 0.13].map((st) => Math.pow(2, st / 12));
  const pan = [0.8, 0.5, 0.2];
  const phase = [0.13, 0.57, 0.91];
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const f = freq(i / n);
    for (let k = 0; k < 3; k++) {
      const dt = (f * detune[k]!) / sr;
      phase[k] = (phase[k]! + dt) % 1;
      const s = 2 * phase[k]! - 1 - polyBlep(phase[k]!, dt);
      out[0]![i]! += s * pan[k]!;
      out[1]![i]! += s * (1 - pan[k]!);
    }
  }
  return out;
}

function highpass(chs: Float32Array[], sr: number, freq: number): void {
  for (const ch of chs) {
    const a = new Biquad().set('highpass', freq, 0.7, sr);
    const b = new Biquad().set('highpass', freq, 0.7, sr);
    for (let i = 0; i < ch.length; i++) ch[i] = b.process(a.process(ch[i]!));
  }
}

function riser(sr: number, n: number, seed: number): Float32Array[] {
  const noise = sweptNoise(n, sr, seed, (x) => 300 * Math.pow(9000 / 300, x), 1.4);
  const tone = saws(n, sr, (x) => 220 * Math.pow(4, x));
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const env = db(-30 + 30 * Math.pow(x, 1.6));
    for (let c = 0; c < 2; c++) out[c]![i] = env * (noise[c]![i]! * 2.2 + tone[c]![i]! * 0.22 * x * x);
  }
  highpass(out, sr, 150);
  return finish(out, sr, 0.8, 0.002, 0.002);
}

function downlifter(sr: number, n: number, seed: number): Float32Array[] {
  const noise = sweptNoise(n, sr, seed, (x) => 9000 * Math.pow(300 / 9000, x), 1.4);
  const tone = saws(n, sr, (x) => 880 * Math.pow(1 / 8, x));
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const env = db(-36 * Math.pow(x, 0.8));
    for (let c = 0; c < 2; c++) out[c]![i] = env * (noise[c]![i]! * 2.2 + tone[c]![i]! * 0.2 * (1 - x));
  }
  highpass(out, sr, 150);
  return finish(out, sr, 0.7, 0.002, 0.03);
}

/** 808-style metal: six detuned squares at the hat ratios. */
function metal(n: number, sr: number): Float32Array {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 1.47);
  const phases = new Float64Array(freqs.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      phases[k] = (phases[k]! + freqs[k]! / sr) % 1;
      s += phases[k]! < 0.5 ? 1 : -1;
    }
    out[i] = s / freqs.length;
  }
  return out;
}

function reverseCrash(sr: number, n: number, seed: number): Float32Array[] {
  const tau = (n / sr) / 3.2;
  const src = metal(n, sr);
  const out = [0, 1].map((c) => {
    const rng = new Rng(seed + c * 104729);
    const hp = new Biquad().set('highpass', 4800, 0.7, sr);
    const shelf = new Biquad().set('highshelf', 9000, 0.7, sr, 3);
    const fwd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      fwd[i] = shelf.process(hp.process(rng.bipolar() * 0.8 + src[i]! * 0.3)) * Math.exp(-t / tau) * Math.min(1, t / 0.002);
    }
    return fwd.reverse();
  });
  highpass(out, sr, 150);
  return finish(out, sr, 0.7, 0.01, 0.0005);
}

function whoosh(sr: number, n: number, seed: number): Float32Array[] {
  const noise = sweptNoise(n, sr, seed, (x) => 400 * Math.pow(15, Math.sin(Math.PI * x)), 2);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const env = Math.pow(Math.sin(Math.PI * x), 2);
    out[0]![i] = noise[0]![i]! * env * (1 - 0.6 * x);
    out[1]![i] = noise[1]![i]! * env * (0.4 + 0.6 * x);
  }
  highpass(out, sr, 150);
  return finish(out, sr, 0.6, 0.005, 0.02);
}

function impact(sr: number, n: number, seed: number): Float32Array[] {
  const out = [new Float32Array(n), new Float32Array(n)];
  let phase = 0;
  const crackRng = new Rng(seed);
  const crack = new Biquad().set('bandpass', 1500, 0.8, sr);
  const tails = [0, 1].map((c) => ({ rng: new Rng(seed + 31 + c * 977), lp: 0 }));
  const lpA = 1 - Math.exp((-TAU * 1800) / sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (TAU * (45 + 115 * Math.exp(-t / 0.06))) / sr;
    const boom = Math.tanh(1.6 * Math.sin(phase)) * Math.exp(-t / 0.7) * Math.min(1, t / 0.0005);
    const hit = crack.process(crackRng.bipolar()) * Math.exp(-t / 0.05) * 1.8;
    for (let c = 0; c < 2; c++) {
      const tl = tails[c]!;
      tl.lp += lpA * (tl.rng.bipolar() - tl.lp);
      out[c]![i] = boom * 0.9 + hit + tl.lp * 0.5 * Math.exp(-t / 1.1) * Math.min(1, t / 0.01);
    }
  }
  return finish(out, sr, 0.9, 0.0002, 0.08);
}

function subDrop(sr: number, n: number): Float32Array[] {
  const out = new Float32Array(n);
  const secs = n / sr;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (TAU * 65 * Math.pow(28 / 65, Math.min(1, t / secs))) / sr;
    out[i] = Math.tanh(1.3 * Math.sin(phase)) * Math.exp(-t / 0.9) * Math.min(1, t / 0.004);
  }
  return finish([out, Float32Array.from(out)], sr, 0.9, 0.0005, 0.1);
}

const MAKERS: Record<FxKind, (sr: number, n: number, seed: number) => Float32Array[]> = {
  riser,
  downlifter,
  'reverse-crash': reverseCrash,
  whoosh,
  impact,
  'sub-drop': (sr, n) => subDrop(sr, n),
};

/** The FX sample for a name from `fxName()` (null for other names). */
export function generateFx(name: string, sampleRate: number): Float32Array[] | null {
  const f = parseFxName(name);
  if (!f) return null;
  const n = Math.max(1, Math.round(fxSeconds(f) * sampleRate));
  return MAKERS[f.kind](sampleRate, n, seedOf(name));
}
