/**
 * Synthetic mouth-sound stand-ins for voice-analysis tests (exported so other tests can use them):
 * kick, snare, hat, hums with glides and legato note changes, breath and noise floors, plus
 * builders for drum patterns and scores with known onset times. Deterministic (seeded noise).
 */
import { butterworth, filterInPlace } from './filters';

/** Seeded uniform [0, 1) generator (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The kinds of synthetic mouth sound the test signals can make. */
export type SynthKind = 'kick' | 'snare' | 'hat' | 'hum';

function whiteNoise(length: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
  return out;
}

function normalize(x: Float32Array, peak = 1): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] as number));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = ((x[i] as number) * peak) / m;
  return x;
}

/** Linear fade-out over the last `sec` seconds (avoids a click when the sound is cut). */
function fadeOut(x: Float32Array, sampleRate: number, sec = 0.005): Float32Array {
  const n = Math.min(x.length, Math.round(sec * sampleRate));
  for (let i = 0; i < n; i++) {
    const j = x.length - 1 - i;
    x[j] = ((x[j] as number) * i) / n;
  }
  return x;
}

/** Kick: sine sweeping 120 → ~50 Hz, decaying to −30 dB at ~150 ms, plus a 2 ms noise click. Peak 1. */
export function synthKick(sampleRate: number, seed = 1): Float32Array {
  const n = Math.round(0.16 * sampleRate);
  const out = new Float32Array(n);
  const click = whiteNoise(Math.round(0.003 * sampleRate), seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = 50 + 70 * Math.exp(-t / 0.04);
    phase += (2 * Math.PI * f) / sampleRate;
    let v = Math.sin(phase) * Math.exp(-t / 0.045);
    if (i < click.length) v += 0.5 * (click[i] as number) * Math.exp(-t / 0.0007);
    out[i] = v;
  }
  return fadeOut(normalize(out), sampleRate);
}

/** Snare: noise band-passed to ~1–6 kHz plus a 180 Hz tone, decaying to −30 dB at ~120 ms. Peak 1. */
export function synthSnare(sampleRate: number, seed = 2): Float32Array {
  const n = Math.round(0.13 * sampleRate);
  const noise = whiteNoise(n, seed);
  filterInPlace(noise, butterworth('highpass', 2, 1000, sampleRate));
  filterInPlace(noise, butterworth('lowpass', 2, 6000, sampleRate));
  normalize(noise);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.035);
    out[i] = env * ((noise[i] as number) + 0.4 * Math.sin(2 * Math.PI * 180 * t));
  }
  return fadeOut(normalize(out), sampleRate);
}

/** Hat: noise high-passed above ~6 kHz, 40 ms (−30 dB at the end). Peak 1. */
export function synthHat(sampleRate: number, seed = 3, durationSec = 0.04): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = whiteNoise(n, seed);
  filterInPlace(out, butterworth('highpass', 4, Math.min(6000, sampleRate * 0.3), sampleRate));
  const tau = durationSec / 3.45;
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * Math.exp(-i / sampleRate / tau);
  return fadeOut(normalize(out), sampleRate, 0.002);
}

/** How to build a synthetic hum: its pitch and length, an optional glide, legato changes and its attack and release. */
export interface HumOptions {
  /** Starting pitch in Hz. */
  hz: number;
  /** Total length including attack and release (default 0.4 s). */
  durationSec?: number;
  /** Glide target: the pitch moves (linearly in semitones) from `hz` to this over [glideStartSec, glideEndSec]. */
  glideToHz?: number;
  /** Default 0 (glide over the whole note). */
  glideStartSec?: number;
  /** Default `durationSec`. */
  glideEndSec?: number;
  /**
   * Legato notes after the first one: each `[hz, startSec]` changes the pitch at `startSec` (from the
   * start of the hum) with a 15 ms transition and no change in level.
   */
  legato?: [hz: number, startSec: number][];
  /** Raised-cosine attack, default 0.02 s. */
  attackSec?: number;
  /** Raised-cosine release, default 0.05 s. */
  releaseSec?: number;
}

/** Hum: sawtooth-like tone (harmonic h at 1/h^1.5, up to ~5 kHz) with soft attack and release. Peak 1. */
export function synthHum(sampleRate: number, opts: HumOptions): Float32Array {
  const dur = opts.durationSec ?? 0.4;
  const n = Math.round(dur * sampleRate);
  const attack = opts.attackSec ?? 0.02;
  const release = opts.releaseSec ?? 0.05;
  const glideStart = opts.glideStartSec ?? 0;
  const glideEnd = opts.glideEndSec ?? dur;
  const legato = opts.legato ?? [];
  const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
  const start = midiOf(opts.hz);
  const pitchAt = (t: number): number => {
    let m = start;
    if (opts.glideToHz !== undefined) {
      const u = Math.min(1, Math.max(0, (t - glideStart) / Math.max(1e-6, glideEnd - glideStart)));
      m = start + u * (midiOf(opts.glideToHz) - start);
    }
    for (const [hz, at] of legato) {
      const u = Math.min(1, Math.max(0, (t - at) / 0.015));
      if (u > 0) m = m + u * (midiOf(hz) - m);
    }
    return 440 * Math.pow(2, (m - 69) / 12);
  };
  let maxHz = opts.hz;
  for (const hz of [opts.glideToHz ?? 0, ...legato.map((l) => l[0])]) maxHz = Math.max(maxHz, hz);
  const harmonics = Math.max(1, Math.min(16, Math.floor(Math.min(5000, sampleRate * 0.45) / maxHz)));
  // One period as a wavetable (fixed harmonic phases so the waveform isn't too peaky).
  const size = 4096;
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * h * i) / size + h * 0.7) / Math.pow(h, 1.5);
    table[i] = v;
  }
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    phase += pitchAt(t) / sampleRate;
    phase -= Math.floor(phase);
    const p = phase * size;
    const j = Math.floor(p);
    const v = (table[j] as number) + (p - j) * ((table[j + 1] as number) - (table[j] as number));
    let env = 1;
    if (t < attack) env = 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
    const left = dur - t;
    if (left < release) env *= 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, left)) / release);
    out[i] = v * env;
  }
  return normalize(out);
}

/** White noise at an RMS level in dBFS. */
export function noiseFloor(sampleRate: number, durationSec: number, rmsDb: number, seed = 9): Float32Array {
  const out = whiteNoise(Math.round(durationSec * sampleRate), seed);
  const g = Math.pow(10, rmsDb / 20) * Math.sqrt(3); // uniform noise in [−1, 1) has RMS 1/√3
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * g;
  return out;
}

/** A breath: low-passed noise swelling in and out over `durationSec`. Peak 1. */
export function synthBreath(sampleRate: number, durationSec = 0.6, seed = 11): Float32Array {
  const out = whiteNoise(Math.round(durationSec * sampleRate), seed);
  filterInPlace(out, butterworth('lowpass', 2, 2500, sampleRate));
  filterInPlace(out, butterworth('highpass', 2, 200, sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * Math.sin((Math.PI * i) / out.length) ** 2;
  return normalize(out);
}

/** Adds `source × gain` into `target` starting at `atSec`. */
export function mixInto(target: Float32Array, source: Float32Array, atSec: number, sampleRate: number, gain = 1): void {
  const at = Math.round(atSec * sampleRate);
  for (let i = 0; i < source.length; i++) {
    const j = at + i;
    if (j >= 0 && j < target.length) target[j] = (target[j] as number) + (source[i] as number) * gain;
  }
}

/** Hard-clips in place at ±limit after multiplying by `drive`. */
export function clipInPlace(x: Float32Array, drive: number, limit = 1): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-limit, Math.min(limit, (x[i] as number) * drive));
  return x;
}

/** One sound in a score; `time` is where its first sample lands (the true onset). */
export interface ScoreHit {
  time: number;
  kind: SynthKind;
  /** Peak level (default 0.8). */
  gain?: number;
  /** Hum options (kind 'hum' only). */
  hum?: HumOptions;
  seed?: number;
}

/** A synthetic recording with the sounds placed in it: its samples and the hits that were put in. */
export interface Score {
  samples: Float32Array;
  hits: ScoreHit[];
}

/** Renders hits over an optional noise floor (`noiseDb` dBFS RMS). */
export function renderScore(
  sampleRate: number,
  durationSec: number,
  hits: ScoreHit[],
  opts: { noiseDb?: number; seed?: number } = {},
): Score {
  const samples =
    opts.noiseDb === undefined
      ? new Float32Array(Math.round(durationSec * sampleRate))
      : noiseFloor(sampleRate, durationSec, opts.noiseDb, opts.seed ?? 99);
  const cache = new Map<string, Float32Array>();
  hits.forEach((h, i) => {
    const seed = h.seed ?? (opts.seed ?? 0) * 1000 + i + 1;
    let sound: Float32Array;
    if (h.kind === 'hum') sound = synthHum(sampleRate, h.hum ?? { hz: 110 });
    else {
      const key = `${h.kind}:${seed % 7}`;
      const cached = cache.get(key);
      if (cached) sound = cached;
      else {
        sound =
          h.kind === 'kick'
            ? synthKick(sampleRate, seed % 7)
            : h.kind === 'snare'
              ? synthSnare(sampleRate, seed % 7)
              : synthHat(sampleRate, seed % 7);
        cache.set(key, sound);
      }
    }
    mixInto(samples, sound, h.time, sampleRate, h.gain ?? 0.8);
  });
  return { samples, hits };
}

const PATTERN_KINDS: Record<string, SynthKind> = { k: 'kick', s: 'snare', h: 'hat' };
/** Default levels: mouth hats and snares are quieter than kicks. */
const PATTERN_GAINS: Record<SynthKind, number> = { kick: 0.9, snare: 0.7, hat: 0.45, hum: 0.8 };

/**
 * How to build a drum pattern as a `Pattern`: tempo, where it starts, the step string, and optional timing error and
 * noise.
 */
export interface PatternOptions {
  sampleRate: number;
  bpm: number;
  /** Where step 0 lands (seconds). */
  startSec: number;
  /** One character per step: k = kick, s = snare, h = hat, anything else = rest. Spaces are ignored. */
  pattern: string;
  /** Steps per beat (default 4: 1/16 steps; 8 for 1/32). */
  stepsPerBeat?: number;
  /** Uniform random timing error of ±jitterMs per hit. */
  jitterMs?: number;
  noiseDb?: number;
  seed?: number;
  /** Extra silence after the last step (default 0.5 s). */
  tailSec?: number;
}

/** A synthetic drum pattern: a `Score` plus the step each hit was meant for and the length of a step in seconds. */
export interface Pattern extends Score {
  /** The step each hit was meant for (same order as `hits`). */
  steps: number[];
  stepSec: number;
}

/** Drum pattern with known onsets: `'k-h-s-h-'` at `bpm`, optionally humanized with jitter. */
export function drumPattern(opts: PatternOptions): Pattern {
  const spb = opts.stepsPerBeat ?? 4;
  const stepSec = 60 / opts.bpm / spb;
  const rand = mulberry32(opts.seed ?? 5);
  const chars = opts.pattern.replace(/\s+/g, '');
  const hits: ScoreHit[] = [];
  const steps: number[] = [];
  for (let s = 0; s < chars.length; s++) {
    const kind = PATTERN_KINDS[chars[s] as string];
    const jitter = ((rand() * 2 - 1) * (opts.jitterMs ?? 0)) / 1000;
    if (!kind) continue;
    hits.push({ time: Math.max(0, opts.startSec + s * stepSec + jitter), kind, gain: PATTERN_GAINS[kind] });
    steps.push(s);
  }
  const duration = opts.startSec + chars.length * stepSec + (opts.tailSec ?? 0.5);
  const score = renderScore(opts.sampleRate, duration, hits, { noiseDb: opts.noiseDb, seed: opts.seed });
  return { ...score, steps, stepSec };
}

/** Maps a synthetic kind to the analyzer's kind. */
export function expectedKind(kind: SynthKind): 'kick' | 'snare' | 'hat' | 'tonal' {
  return kind === 'hum' ? 'tonal' : kind;
}
