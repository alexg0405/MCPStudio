/**
 * A synthetic sung/spoken phrase for the vocal tests: "s – ah – t" every half second. The vowel is a sawtooth
 * glottal source with vibrato through three formant resonators (a melody over A3–E4), the "s" is noise between
 * 4 and 9.5 kHz (the sibilance a de-esser must find), the "t" a short burst, with a
 * faint noise floor in the gaps. Deterministic, mono, peak 0.3 (−10.5 dBFS: a vocal tracked with headroom). Pure TypeScript.
 */
import { Svf } from '@agstudio/sdk/worklet';

/** The pitch of each syllable in Hz. */
const MELODY = [220, 261.63, 329.63, 293.66, 246.94, 329.63];

function noiseGen(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

export interface VoiceOptions {
  /** Level of the "s" against the vowel (default 0.5: a natural "s"; 1 is a harsh one as loud as the vowel). */
  sibilance?: number;
  /** Noise floor between syllables, linear (default 0.002 = −54 dBFS). */
  floor?: number;
}

export function syntheticVoice(seconds: number, sampleRate: number, opts: VoiceOptions = {}): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = noiseGen(2024);
  const formants = [
    { f: new Svf().set('bandpass', 700, 5, sampleRate), g: 1 },
    { f: new Svf().set('bandpass', 1200, 8, sampleRate), g: 0.7 },
    { f: new Svf().set('bandpass', 2600, 10, sampleRate), g: 0.35 },
  ];
  const hiss = new Svf().set('highpass', 4000, 0.707, sampleRate);
  const hissLow = new Svf().set('lowpass', 9500, 0.707, sampleRate);
  const burst = new Svf().set('bandpass', 6500, 1.2, sampleRate);
  const syllable = Math.round(0.5 * sampleRate);
  const sib = opts.sibilance ?? 0.5;
  const floor = opts.floor ?? 0.002;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / syllable);
    const t = (i % syllable) / sampleRate;
    const f0 = (MELODY[k % MELODY.length] as number) * 2 ** ((20 / 1200) * Math.sin(2 * Math.PI * 5.5 * (i / sampleRate)));
    phase += f0 / sampleRate;
    phase -= Math.floor(phase);
    // The glottal source: a sawtooth leaning on its harmonics, then the formants.
    const source = 2 * phase - 1;
    let voiced = 0;
    for (const { f, g } of formants) voiced += g * f.process(source);
    const x = rnd();
    const noise = hissLow.process(hiss.process(x));
    // "s" 0–0.12 s, ah 0.12–0.42 s, "t" 0.42–0.45 s.
    const sEnv = t < 0.12 ? Math.min(1, t / 0.01, (0.12 - t) / 0.02) : 0;
    const vEnv = t >= 0.12 && t < 0.42 ? Math.min(1, (t - 0.12) / 0.02, (0.42 - t) / 0.04) : 0;
    const tEnv = t >= 0.42 && t < 0.45 ? Math.exp(-(t - 0.42) / 0.006) : 0;
    out[i] = 0.9 * vEnv * voiced + 1.1 * sib * sEnv * noise + 0.8 * sib * tEnv * burst.process(x) + floor * x;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const scale = 0.3 / (peak || 1);
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * scale;
  return out;
}
