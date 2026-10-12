/**
 * Procedural drum kit. Pure functions (sampleRate, seed) → channel data, so nothing is downloaded and
 * every render is deterministic. Never change the output of a published KIT_VERSION: bump the version
 * and keep the old generator so existing projects keep sounding the same.
 */
import { Biquad } from '@agstudio/sdk/dsp/biquad';
import { Rng } from '@agstudio/sdk/dsp/random';

export type Generator = (sampleRate: number, seed: number) => Float32Array[];

const TAU = Math.PI * 2;

function normalize(chs: Float32Array[], peak = 0.9): Float32Array[] {
  let max = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i] as number));
  const g = max > 0 ? peak / max : 0;
  for (const ch of chs) {
    const fade = Math.min(ch.length, 256);
    for (let i = 0; i < ch.length; i++) {
      let v = (ch[i] as number) * g;
      const fromEnd = ch.length - 1 - i;
      if (fromEnd < fade) v *= fromEnd / fade;
      ch[i] = v;
    }
  }
  return chs;
}

const len = (sr: number, seconds: number) => Math.max(1, Math.round(sr * seconds));

/** Pitch-swept sine body (kicks and toms). */
function body(
  sr: number,
  seconds: number,
  base: number,
  sweep: number,
  sweepTau: number,
  ampTau: number,
  drive: number,
): Float32Array {
  const out = new Float32Array(len(sr, seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = base + sweep * Math.exp(-t / sweepTau);
    phase += (TAU * f) / sr;
    const attack = Math.min(1, t / 0.0015);
    out[i] = Math.tanh(drive * Math.sin(phase)) * Math.exp(-t / ampTau) * attack;
  }
  return out;
}

const kick: Generator = (sr, seed) => {
  const out = body(sr, 0.6, 46, 140, 0.032, 0.24, 1.7);
  // Short high-passed noise click for attack.
  const rng = new Rng(seed);
  const hp = new Biquad().set('highpass', 2500, 0.7, sr);
  const click = len(sr, 0.004);
  for (let i = 0; i < click; i++) out[i] = (out[i] as number) + hp.process(rng.bipolar()) * 0.35 * (1 - i / click);
  return normalize([out]);
};

function tom(base: number): Generator {
  return (sr) => normalize([body(sr, 0.7, base, base * 0.6, 0.05, 0.18, 1.2)]);
}

const snare: Generator = (sr, seed) => {
  const out = new Float32Array(len(sr, 0.42));
  const rng = new Rng(seed);
  const hp = new Biquad().set('highpass', 1500, 0.7, sr);
  const peak = new Biquad().set('peaking', 5000, 1, sr, 4);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    p1 += (TAU * (185 + 40 * Math.exp(-t / 0.01))) / sr;
    p2 += (TAU * 330) / sr;
    const tone = (Math.sin(p1) * 0.7 + Math.sin(p2) * 0.4) * Math.exp(-t / 0.055);
    const noise = peak.process(hp.process(rng.bipolar())) * Math.exp(-t / 0.13);
    out[i] = (tone * 0.9 + noise * 0.8) * Math.min(1, t / 0.0008);
  }
  return normalize([out]);
};

const clap: Generator = (sr, seed) => {
  const out = new Float32Array(len(sr, 0.5));
  const rng = new Rng(seed);
  const bp = new Biquad().set('bandpass', 1200, 1.4, sr);
  const hp = new Biquad().set('highpass', 600, 0.7, sr);
  const bursts = [0, 0.011, 0.022];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.0075));
    if (t >= 0.03) env = Math.max(env, 0.55 * Math.exp(-(t - 0.03) / 0.11));
    out[i] = hp.process(bp.process(rng.bipolar())) * env;
  }
  return normalize([out]);
};

/** 808-style metallic source: six detuned square waves. */
function metal(sr: number, n: number, ratioScale = 1): Float32Array {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * ratioScale);
  const out = new Float32Array(n);
  const phases = new Float64Array(freqs.length);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      phases[k] = ((phases[k] as number) + (freqs[k] as number) / sr) % 1;
      s += (phases[k] as number) < 0.5 ? 1 : -1;
    }
    out[i] = s / freqs.length;
  }
  return out;
}

function hat(seconds: number, tau: number): Generator {
  return (sr, seed) => {
    const n = len(sr, seconds);
    const src = metal(sr, n);
    const rng = new Rng(seed);
    const bp = new Biquad().set('bandpass', 10000, 0.9, sr);
    const hp = new Biquad().set('highpass', 7000, 0.7, sr);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = (src[i] as number) * 0.8 + rng.bipolar() * 0.35;
      out[i] = hp.process(bp.process(x)) * Math.exp(-t / tau) * Math.min(1, t / 0.0005);
    }
    return normalize([out], 0.8);
  };
}

const rim: Generator = (sr, seed) => {
  const out = new Float32Array(len(sr, 0.09));
  const rng = new Rng(seed);
  const hp = new Biquad().set('highpass', 3000, 0.7, sr);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    p1 += (TAU * 1700) / sr;
    p2 += (TAU * 480) / sr;
    out[i] = (Math.sin(p1) * 0.6 + Math.sin(p2) * 0.5 + hp.process(rng.bipolar()) * 0.5) * Math.exp(-t / 0.009);
  }
  return normalize([out]);
};

const cowbell: Generator = (sr) => {
  const out = new Float32Array(len(sr, 0.5));
  const bp = new Biquad().set('bandpass', 2600, 1.2, sr);
  let a = 0;
  let b = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    a = (a + 540 / sr) % 1;
    b = (b + 800 / sr) % 1;
    const sq = (a < 0.5 ? 1 : -1) + (b < 0.5 ? 1 : -1);
    const env = 0.7 * Math.exp(-t / 0.03) + 0.3 * Math.exp(-t / 0.22);
    out[i] = bp.process(sq) * env;
  }
  return normalize([out], 0.8);
};

const crash: Generator = (sr, seed) => {
  const n = len(sr, 2.6);
  const src = metal(sr, n, 1.47);
  const out: Float32Array[] = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const rng = new Rng(seed + c * 7919);
    const hp = new Biquad().set('highpass', 4800, 0.7, sr);
    const shelf = new Biquad().set('highshelf', 9000, 0.7, sr, 3);
    const ch = out[c] as Float32Array;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const x = rng.bipolar() * 0.8 + (src[i] as number) * 0.3;
      ch[i] = shelf.process(hp.process(x)) * Math.exp(-t / 0.9) * Math.min(1, t / 0.002);
    }
  }
  return normalize(out, 0.75);
};

export const GENERATORS: Readonly<Record<string, Generator>> = {
  'kit/kick': kick,
  'kit/snare': snare,
  'kit/clap': clap,
  'kit/hat-closed': hat(0.14, 0.022),
  'kit/hat-open': hat(0.7, 0.2),
  'kit/tom-low': tom(92),
  'kit/tom-mid': tom(128),
  'kit/tom-high': tom(176),
  'kit/rim': rim,
  'kit/cowbell': cowbell,
  'kit/crash': crash,
};

/** Seed derived from the generator name so each sound has stable, distinct noise. */
export function seedFor(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function generate(name: string, sampleRate: number): Float32Array[] | null {
  const gen = GENERATORS[name];
  return gen ? gen(sampleRate, seedFor(name)) : null;
}
