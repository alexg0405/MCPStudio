/**
 * A synthetic sung/spoken phrase with known parts, for the vocal cleanup tests (exported so other tests can use it):
 * voiced syllables (a harmonic voice with vibrato and a formant), a few "s" sounds right before vowels, breaths
 * (band-limited noise swells between phrases), room noise, and mouth clicks. Every part is returned on its own
 * as well as mixed, so a test can measure what a cleanup did to each. Deterministic (seeded). Pure TypeScript.
 */
import { mulberry32 } from '../../voice/test-signals';

/** A stretch of the phrase in seconds. */
export interface Span {
  from: number;
  to: number;
}

/** What `syntheticPhrase` makes. */
export interface PhraseOptions {
  /** Length in seconds (default 12). */
  seconds?: number;
  /** Sample rate in Hz (default 48000). */
  sampleRate?: number;
  /** Level of the room noise: its RMS in dBFS (default −50). */
  noiseDb?: number;
  /** Peak level of a breath relative to the vowels' RMS, dB (default −16: a clear but quiet breath). */
  breathDb?: number;
  /** RMS of the "s" sounds relative to the vowels, dB (default −8: a clear "s", louder than a breath). */
  hissDb?: number;
  /** Hum at 50 Hz and its harmonics added to the noise, RMS in dBFS (default none). */
  humDb?: number;
  /** Seed of the noise and breaths. */
  seed?: number;
}

/** The parts of a phrase. */
export interface Phrase {
  sampleRate: number;
  /** The voice alone (vowels and "s" sounds). */
  voice: Float32Array;
  /** The room noise alone. */
  noise: Float32Array;
  /** The breaths alone. */
  breaths: Float32Array;
  /** Voice + breaths + noise. */
  mix: Float32Array;
  /** The vowels (the voiced syllables), seconds. */
  vowels: Span[];
  /** The "s" sounds before some vowels, seconds. */
  hisses: Span[];
  /** The breaths, seconds. */
  breathSpans: Span[];
  /** Stretches with only the room noise, seconds. */
  quiet: Span[];
}

const TAU = 2 * Math.PI;
/** Seconds of the opening silence: the room noise alone, where a profile can be learned. */
const LEAD_IN = 0.8;
/** Vowel length, gap between syllables of a phrase, and the pause (with a breath) between phrases, seconds. */
const VOWEL = 0.32;
const GAP = 0.12;
const PAUSE = 0.9;
/** Syllables per phrase. */
const PER_PHRASE = 4;
/** Pitches of the syllables, Hz (a 150–250 Hz voice). */
const PITCHES = [196, 220, 246.94, 174.61, 207.65, 233.08, 164.81, 185];

/** RMS of a stretch of samples. */
export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] as number) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** dB of a linear amplitude (−200 for silence). */
export const toDb = (linear: number): number => (linear > 1e-10 ? 20 * Math.log10(linear) : -200);

/** Pink-ish noise (a −3 dB/octave tilt, Paul Kellet's filter), scaled to the RMS `db` dBFS. */
export function pinkNoise(length: number, db: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[i] = b0 + b1 + b2 + white * 0.1848;
  }
  const gain = Math.pow(10, db / 20) / (rms(out) || 1);
  for (let i = 0; i < length; i++) out[i] = (out[i] as number) * gain;
  return out;
}

/** Noise between `lowHz` and `highHz` (a difference of two one-pole filters, steep enough for a hiss or breath). */
function bandNoise(length: number, lowHz: number, highHz: number, sampleRate: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  const hi = Math.exp(-TAU * highHz / sampleRate);
  const lo = Math.exp(-TAU * lowHz / sampleRate);
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    // Two cascaded low-passes at the high edge, minus two at the low edge.
    a = (1 - hi) * white + hi * a;
    b = (1 - hi) * a + hi * b;
    c = (1 - lo) * white + lo * c;
    d = (1 - lo) * c + lo * d;
    out[i] = b - d;
  }
  return out;
}

/** 0 → 1 → 0 swell: rises over `rise` seconds, falls over `fall` seconds, `length` seconds long in all. */
function swell(t: number, length: number, rise: number, fall: number): number {
  if (t < 0 || t > length) return 0;
  const up = Math.min(1, t / rise);
  const down = Math.min(1, (length - t) / fall);
  return Math.sin((Math.PI / 2) * up) * Math.sin((Math.PI / 2) * down);
}

/** Adds one voiced syllable at `at` seconds: harmonics of `hz` under a formant at 700 Hz and one at 2.4 kHz, vibrato 5.5 Hz. */
function addVowel(out: Float32Array, at: number, hz: number, sampleRate: number): void {
  const start = Math.round(at * sampleRate);
  const length = Math.round(VOWEL * sampleRate);
  const harmonics = Math.floor(5000 / hz);
  let phase = 0;
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / sampleRate;
    const vibrato = Math.pow(2, (14 / 1200) * Math.sin(TAU * 5.5 * t));
    phase += (TAU * hz * vibrato) / sampleRate;
    const envelope = swell(t, VOWEL, 0.025, 0.05);
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      const f = hz * h;
      const formant = 1 + 4 * Math.exp(-(((f - 700) / 160) ** 2)) + 2 * Math.exp(-(((f - 2400) / 300) ** 2));
      v += (formant / h) * Math.sin(h * phase);
    }
    out[start + i] = (out[start + i] as number) + envelope * v;
  }
}

/**
 * The phrase: LEAD_IN of silence, then groups of four syllables (the first of each group starts with an "s"), a
 * pause with a breath in it after each group. Levels: vowels about −22 dBFS RMS, the "s" 10 dB below them.
 */
export function syntheticPhrase(opts: PhraseOptions = {}): Phrase {
  const sampleRate = opts.sampleRate ?? 48000;
  const length = Math.round((opts.seconds ?? 12) * sampleRate);
  const seed = opts.seed ?? 7;
  const voice = new Float32Array(length);
  const breaths = new Float32Array(length);
  const vowels: Span[] = [];
  const hisses: Span[] = [];
  const breathSpans: Span[] = [];
  const hissNoise = bandNoise(length, 3500, 9000, sampleRate, seed + 1);
  const breathNoise = bandNoise(length, 400, 7000, sampleRate, seed + 2);

  let t = LEAD_IN;
  let syllable = 0;
  while (t + PER_PHRASE * (VOWEL + GAP) + PAUSE < length / sampleRate) {
    for (let i = 0; i < PER_PHRASE; i++) {
      if (i === 0) {
        const hissLength = 0.11;
        hisses.push({ from: t, to: t + hissLength });
        const first = Math.round(t * sampleRate);
        for (let j = 0; j < Math.round(hissLength * sampleRate); j++) {
          voice[first + j] = (voice[first + j] as number) + swell(j / sampleRate, hissLength, 0.015, 0.02) * (hissNoise[first + j] as number) * 6;
        }
        t += hissLength;
      }
      addVowel(voice, t, PITCHES[syllable % PITCHES.length] as number, sampleRate);
      vowels.push({ from: t, to: t + VOWEL });
      syllable++;
      t += VOWEL + GAP;
    }
    // The breath: in the pause, 0.2 s after the last vowel, 0.35 s long.
    const breathStart = t - GAP + 0.2;
    const breathLength = 0.35;
    breathSpans.push({ from: breathStart, to: breathStart + breathLength });
    const first = Math.round(breathStart * sampleRate);
    for (let j = 0; j < Math.round(breathLength * sampleRate); j++) {
      breaths[first + j] = (breathNoise[first + j] as number) * swell(j / sampleRate, breathLength, 0.12, 0.15);
    }
    t += PAUSE - GAP;
  }

  // Levels: vowels at −22 dBFS RMS, the "s" and breaths relative to that.
  let vowelPower = 0;
  let vowelFrames = 0;
  for (const v of vowels) {
    const a = Math.round(v.from * sampleRate);
    const b = Math.round(v.to * sampleRate);
    for (let i = a; i < b; i++) vowelPower += (voice[i] as number) ** 2;
    vowelFrames += b - a;
  }
  const vowelRms = Math.sqrt(vowelPower / Math.max(1, vowelFrames));
  // The "s" sounds are brought to their level relative to the vowels (they were made with a rough gain).
  for (const h of hisses) {
    const a = Math.round(h.from * sampleRate);
    const b = Math.round(h.to * sampleRate);
    const fix = (vowelRms * Math.pow(10, (opts.hissDb ?? -8) / 20)) / (rms(voice, a, b) || 1);
    for (let i = a; i < b; i++) voice[i] = (voice[i] as number) * fix;
  }
  const voiceGain = Math.pow(10, -22 / 20) / (vowelRms || 1);
  for (let i = 0; i < length; i++) voice[i] = (voice[i] as number) * voiceGain;
  const breathPeak = peakRms(breaths, breathSpans, sampleRate);
  const breathGain = (Math.pow(10, (opts.breathDb ?? -16) / 20) * Math.pow(10, -22 / 20)) / (breathPeak || 1);
  for (let i = 0; i < length; i++) breaths[i] = (breaths[i] as number) * breathGain;

  const noise = pinkNoise(length, opts.noiseDb ?? -50, seed + 3);
  if (opts.humDb !== undefined) addHum(noise, opts.humDb, sampleRate);
  const mix = new Float32Array(length);
  for (let i = 0; i < length; i++) mix[i] = (voice[i] as number) + (breaths[i] as number) + (noise[i] as number);

  const quiet: Span[] = [{ from: 0.05, to: LEAD_IN - 0.05 }];
  return { sampleRate, voice, noise, breaths, mix, vowels, hisses, breathSpans, quiet };
}

/** The loudest 50 ms RMS inside the spans. */
function peakRms(x: Float32Array, spans: readonly Span[], sampleRate: number): number {
  const window = Math.round(0.05 * sampleRate);
  let peak = 0;
  for (const span of spans) {
    const a = Math.round(span.from * sampleRate);
    const b = Math.round(span.to * sampleRate);
    for (let i = a; i + window < b; i += window >> 1) peak = Math.max(peak, rms(x, i, i + window));
  }
  return peak;
}

/** Mains hum: 50 Hz and its first five harmonics (falling off), added to `x` at `db` dBFS RMS. */
function addHum(x: Float32Array, db: number, sampleRate: number): void {
  const hum = new Float32Array(x.length);
  for (let h = 1; h <= 6; h++) for (let i = 0; i < hum.length; i++) hum[i] = (hum[i] as number) + Math.sin((TAU * 50 * h * i) / sampleRate) / h;
  const gain = Math.pow(10, db / 20) / (rms(hum) || 1);
  for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) + (hum[i] as number) * gain;
}
