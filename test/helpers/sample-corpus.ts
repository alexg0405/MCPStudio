/**
 * A labelled corpus of synthetic one-shots for the sample browser's tests: the engine's kit generators and the Drum Pads'
 * built-in sounds (independent of the classifier's author) plus randomized hand-made kicks, snares, claps, hats, cymbals,
 * toms, 808s, tonal notes, FX and a vocal. Deterministic. Mono, at `SR`.
 */
import { mulberry32 } from '@core/voice/test-signals';
import { butterworth, filterInPlace } from '@core/voice/filters';
import { Svf } from '@agstudio/sdk/worklet';
import type { SampleCategory } from '@core/samples/types';
import { generate } from '@engine/kit/generators';
import { builtinSound } from '../../src/plugins/builtin/drum-pads/sounds.kernel';
import type { SoundId } from '../../src/plugins/builtin/drum-pads/params';

/** The rate the corpus is made at (default 44.1 kHz; `corpusAt` changes it for one call). */
export let SR = 44100;

/** Runs `make` with the corpus at another sample rate. */
export function corpusAt<T>(rate: number, make: () => T): T {
  const before = SR;
  SR = rate;
  try {
    return make();
  } finally {
    SR = before;
  }
}

export interface CorpusSound {
  name: string;
  /** What it is. */
  label: SampleCategory;
  /** A clear case: a person would not argue (counts towards the accuracy target). */
  clear: boolean;
  x: Float32Array;
  /** Tonal sounds: the MIDI note. */
  midi?: number;
}

const normalize = (x: Float32Array, peak = 0.9): Float32Array => {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) * (peak / m);
  return x;
};

const noise = (n: number, rnd: () => number): Float32Array => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd() * 2 - 1;
  return out;
};

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A short fade so the file doesn't end on a click. */
function fade(x: Float32Array, sec = 0.004): Float32Array {
  const n = Math.min(x.length, Math.round(sec * SR));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] = (x[x.length - 1 - i] as number) * (i / n);
  return x;
}

function bandpass(x: Float32Array, hzc: number, q: number): void {
  const f = new Svf().set('bandpass', hzc, q, SR);
  for (let i = 0; i < x.length; i++) x[i] = f.process(x[i] as number);
}

function kick(rnd: () => number): Float32Array {
  const f0 = 38 + rnd() * 30; // body pitch
  const f1 = f0 + 60 + rnd() * 110; // start of the sweep
  const sweep = 0.015 + rnd() * 0.05;
  const decay = 0.08 + rnd() * 0.3;
  const len = Math.round((0.25 + decay * 2.2) * SR);
  const out = new Float32Array(len);
  const clickAmt = rnd() * 0.5;
  const click = noise(Math.round(0.004 * SR), rnd);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (f0 + (f1 - f0) * Math.exp(-t / sweep))) / SR;
    let v = Math.sin(ph) * Math.exp(-t / decay);
    if (i < click.length) v += clickAmt * (click[i] as number) * Math.exp(-t / 0.0008);
    out[i] = v;
  }
  return fade(normalize(out));
}

function snare(rnd: () => number): Float32Array {
  const len = Math.round((0.18 + rnd() * 0.3) * SR);
  const n = noise(len, rnd);
  filterInPlace(n, butterworth('highpass', 2, 600 + rnd() * 700, SR));
  filterInPlace(n, butterworth('lowpass', 2, 5000 + rnd() * 4000, SR));
  const tone = 160 + rnd() * 90;
  const decay = 0.04 + rnd() * 0.08;
  const out = new Float32Array(len);
  const toneAmt = 0.5 + rnd() * 0.7;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = Math.exp(-t / decay) * ((n[i] as number) + toneAmt * Math.sin(2 * Math.PI * tone * t) * Math.exp(-t / 0.05));
  }
  return fade(normalize(out));
}

function clap(rnd: () => number): Float32Array {
  const len = Math.round((0.22 + rnd() * 0.25) * SR);
  const n = noise(len, rnd);
  filterInPlace(n, butterworth('highpass', 2, 700, SR));
  filterInPlace(n, butterworth('lowpass', 2, 2500 + rnd() * 2500, SR));
  const out = new Float32Array(len);
  const gap = 0.008 + rnd() * 0.006;
  const decay = 0.05 + rnd() * 0.07;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // Three short bursts, then the tail.
    let env = Math.exp(-Math.max(0, t - 3 * gap) / decay) * (t >= 3 * gap ? 1 : 0);
    for (let b = 0; b < 3; b++) {
      const tb = t - b * gap;
      if (tb >= 0 && tb < gap) env = Math.max(env, Math.exp(-tb / 0.0025));
    }
    out[i] = env * (n[i] as number);
  }
  return fade(normalize(out));
}

function hat(rnd: () => number, open: boolean): Float32Array {
  const decay = open ? 0.07 + rnd() * 0.1 : 0.012 + rnd() * 0.02;
  const len = Math.round((open ? decay * 7.5 : 0.06 + decay * 5) * SR);
  const n = noise(len, rnd);
  filterInPlace(n, butterworth('highpass', 4, 5000 + rnd() * 3000, SR));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (n[i] as number) * Math.exp(-i / SR / decay);
  return fade(normalize(out), 0.002);
}

function cymbal(rnd: () => number): Float32Array {
  const decay = 0.7 + rnd() * 0.8;
  const len = Math.round(Math.min(4.5, decay * 7.5) * SR);
  const n = noise(len, rnd);
  filterInPlace(n, butterworth('highpass', 2, 3000 + rnd() * 2000, SR));
  const out = new Float32Array(len);
  const shimmer = rnd() * 0.4;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = (n[i] as number) * Math.exp(-t / decay) * (1 + shimmer * Math.sin(2 * Math.PI * 7 * t));
  }
  return fade(normalize(out), 0.01);
}

function tom(rnd: () => number): Float32Array {
  const f0 = 85 + rnd() * 140;
  const decay = 0.12 + rnd() * 0.2;
  const len = Math.round(decay * 6 * SR);
  const out = new Float32Array(len);
  const click = noise(Math.round(0.003 * SR), rnd);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * f0 * (1 + 0.25 * Math.exp(-t / 0.03))) / SR;
    let v = Math.sin(ph) * Math.exp(-t / decay);
    if (i < click.length) v += 0.25 * (click[i] as number) * Math.exp(-t / 0.001);
    out[i] = v;
  }
  return fade(normalize(out));
}

function eight08(rnd: () => number): { x: Float32Array; midi: number } {
  const midi = 24 + Math.floor(rnd() * 14); // C1–D♯2
  const f = hz(midi);
  const decay = 0.7 + rnd() * 1.2;
  const len = Math.round(Math.min(3.8, decay * 4.2) * SR);
  const out = new Float32Array(len);
  const drop = 1 + rnd() * 0.5;
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * f * (1 + drop * Math.exp(-t / 0.03))) / SR;
    const v = Math.sin(ph) + 0.15 * Math.sin(2 * ph);
    out[i] = Math.tanh(1.6 * v) * Math.exp(-t / decay) * Math.min(1, t / 0.004);
  }
  return { x: fade(normalize(out), 0.9), midi };
}

function tonal(rnd: () => number, style: 'saw' | 'square' | 'pluck' | 'pad' | 'bell'): { x: Float32Array; midi: number } {
  const midi = 50 + Math.floor(rnd() * 36); // D3–C6
  const f = hz(midi);
  const len = Math.round((style === 'pad' ? 2.5 : style === 'pluck' ? 1.2 : 1.6) * SR);
  const out = new Float32Array(len);
  const attack = style === 'pad' ? 0.35 : 0.004;
  const decay = style === 'pluck' ? 0.28 : style === 'bell' ? 0.9 : 2.5;
  const harmonics = style === 'square' ? 15 : style === 'bell' ? 6 : 18;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      if (f * h > 12000) break;
      const g = style === 'square' ? (h % 2 ? 1 / h : 0) : style === 'bell' ? 1 / (h * h) : 1 / h;
      const detune = style === 'bell' ? 1 + 0.0007 * h * h : 1;
      v += g * Math.sin(2 * Math.PI * f * h * detune * t);
    }
    const hold = style === 'pad' ? Math.min(1, (len - i) / (0.4 * SR)) : 1;
    out[i] = v * Math.min(1, t / attack) * Math.exp(-t / decay) * hold;
  }
  return { x: fade(normalize(out), 0.8), midi };
}

function riser(rnd: () => number): Float32Array {
  const len = Math.round((2.5 + rnd() * 2) * SR);
  const n = noise(len, rnd);
  bandpass(n, 1500 + rnd() * 1500, 0.7);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const u = i / len;
    out[i] = (n[i] as number) * Math.pow(u, 2.2) * (i > len - 0.01 * SR ? 0 : 1);
  }
  return normalize(out);
}

function impact(rnd: () => number): Float32Array {
  const len = Math.round((2.5 + rnd()) * SR);
  const n = noise(len, rnd);
  filterInPlace(n, butterworth('lowpass', 2, 900, SR));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = ((n[i] as number) * 2 + Math.sin(2 * Math.PI * 38 * t)) * Math.exp(-t / 0.9);
  }
  return fade(normalize(out), 0.05);
}

/** A sung "ah": a sawtooth through three formants, with vibrato and a small glide. */
function vocal(rnd: () => number): { x: Float32Array; midi: number } {
  const midi = 52 + Math.floor(rnd() * 14);
  const len = Math.round((0.8 + rnd() * 0.8) * SR);
  const out = new Float32Array(len);
  const src = new Float32Array(len);
  let ph = 0;
  const vib = 4.5 + rnd() * 1.5;
  const depth = 0.3 + rnd() * 0.5;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const m = midi + depth * Math.sin(2 * Math.PI * vib * t) + (t < 0.15 ? -0.8 * (1 - t / 0.15) : 0);
    ph += (2 * Math.PI * hz(m)) / SR;
    let v = 0;
    for (let h = 1; h <= 30; h++) v += Math.sin(h * ph) / h;
    src[i] = v;
  }
  const f1 = (x: Float32Array, c: number, q: number): Float32Array => {
    const y = Float32Array.from(x);
    bandpass(y, c, q);
    return y;
  };
  const a = f1(src, 700, 4);
  const b = f1(src, 1200, 6);
  const c = f1(src, 2600, 8);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] = ((a[i] as number) + 0.7 * (b[i] as number) + 0.35 * (c[i] as number)) * Math.min(1, t / 0.05) * Math.min(1, (len - i) / (0.08 * SR));
  }
  return { x: normalize(out, 0.7), midi };
}

const GEN: [string, SampleCategory, boolean][] = [
  ['kit/kick', 'kick', true],
  ['kit/snare', 'snare', true],
  ['kit/clap', 'clap', true],
  ['kit/hat-closed', 'hat', true],
  ['kit/hat-open', 'open-hat', true],
  ['kit/tom-low', 'tom', true],
  ['kit/tom-mid', 'tom', true],
  ['kit/tom-high', 'tom', true],
  ['kit/rim', 'perc', true],
  ['kit/cowbell', 'perc', true],
  ['kit/crash', 'cymbal', true],
];
const GENRES = ['trap', 'house', 'lofi', 'boombap', 'edm', 'bass', 'dnb'];
const GENRE_PIECES: [string, SampleCategory][] = [
  ['kick', 'kick'],
  ['snare', 'snare'],
  ['clap', 'clap'],
  ['hat', 'hat'],
  ['open-hat', 'open-hat'],
];

const PADS: [SoundId, SampleCategory, boolean][] = [
  ['kick', 'kick', true],
  ['kickHard', 'kick', true],
  ['snare', 'snare', true],
  ['snare2', 'snare', true],
  ['rim', 'perc', true],
  ['clap', 'clap', true],
  ['hatClosed', 'hat', true],
  ['hatPedal', 'hat', true],
  ['hatOpen', 'open-hat', true],
  ['crash', 'cymbal', true],
  ['ride', 'cymbal', true],
  ['tomLow', 'tom', true],
  ['tomMid', 'tom', true],
  ['tomHigh', 'tom', true],
  ['cowbell', 'perc', true],
  ['clave', 'perc', true],
  ['shaker', 'perc', false],
  ['conga', 'perc', false],
];

/** The engine's own sounds (kit generators and the Drum Pads' built-ins). */
export function engineCorpus(): CorpusSound[] {
  const out: CorpusSound[] = [];
  for (const [g, label, clear] of GEN) {
    const d = generate(g, SR);
    if (d?.[0]) out.push({ name: g, label, clear, x: d[0] });
  }
  for (const k of GENRES)
    for (const [piece, label] of GENRE_PIECES) {
      const d = generate(`kit/${k}/${piece}`, SR);
      if (d?.[0]) out.push({ name: `kit/${k}/${piece}`, label, clear: true, x: d[0] });
    }
  for (const [id, label, clear] of PADS) {
    const d = builtinSound(id, SR);
    if (d) out.push({ name: `pads/${id}`, label, clear, x: d });
  }
  return out;
}

/** Randomized hand-made sounds, `perClass` of each kind. */
export function handmadeCorpus(perClass = 12, seed = 7): CorpusSound[] {
  const rnd = mulberry32(seed);
  const out: CorpusSound[] = [];
  const add = (name: string, label: SampleCategory, x: Float32Array, midi?: number) =>
    out.push({ name, label, clear: true, x, ...(midi !== undefined ? { midi } : {}) });
  for (let i = 0; i < perClass; i++) {
    add(`kick ${i}`, 'kick', kick(rnd));
    add(`snare ${i}`, 'snare', snare(rnd));
    add(`clap ${i}`, 'clap', clap(rnd));
    add(`hat ${i}`, 'hat', hat(rnd, false));
    add(`open hat ${i}`, 'open-hat', hat(rnd, true));
    add(`cymbal ${i}`, 'cymbal', cymbal(rnd));
    add(`tom ${i}`, 'tom', tom(rnd));
    const e = eight08(rnd);
    add(`808 ${i}`, '808', e.x, e.midi);
    const styles = ['saw', 'square', 'pluck', 'pad', 'bell'] as const;
    const t = tonal(rnd, styles[i % styles.length] as (typeof styles)[number]);
    add(`tonal ${i}`, 'tonal', t.x, t.midi);
    add(`riser ${i}`, 'fx', riser(rnd));
    out.push({ name: `impact ${i}`, label: 'fx', clear: false, x: impact(rnd) });
    const v = vocal(rnd);
    out.push({ name: `vocal ${i}`, label: 'vocal', clear: false, x: v.x, midi: v.midi });
  }
  return out;
}

export { hz as midiToHzForTests };
