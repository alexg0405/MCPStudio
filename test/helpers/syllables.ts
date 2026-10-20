/**
 * Synthetic sung syllables for vocal-alignment tests: each syllable is a short noise burst (the consonant) followed by
 * a sung vowel (`sing`), so it has a sharp attack at a known time. A "lead" and a "double" are built from the same
 * syllables with chosen start times, lengths and pitches, so the right alignment is known exactly.
 */
import { mulberry32 } from '../../src/core/voice/test-signals';
import { sing, type SungNote } from './sung';

/** One syllable of a sung line. */
export interface Syllable {
  /** Where the consonant starts, seconds. */
  startSec: number;
  /** Consonant plus vowel, seconds. */
  durationSec: number;
  /** The pitch of the vowel: a MIDI note, or a function of seconds into the vowel. */
  midi: number | ((t: number) => number);
  /** Linear level of the vowel (default 0.3). */
  level?: number;
}

/** Seconds of consonant noise at the start of a syllable. */
export const CONSONANT_SEC = 0.014;

/** Renders the syllables (consonant burst, then the vowel) into `seconds` of mono audio. */
export function singSyllables(syllables: readonly Syllable[], sampleRate: number, seconds: number, seed = 5): Float32Array {
  const random = mulberry32(seed);
  const vowels: SungNote[] = syllables.map((s) => ({
    from: s.startSec + CONSONANT_SEC * 0.6,
    to: s.startSec + s.durationSec,
    midi: s.midi,
    ...(s.level !== undefined ? { level: s.level } : {}),
  }));
  const out = sing(vowels, sampleRate, seconds);
  for (const s of syllables) {
    const first = Math.round(s.startSec * sampleRate);
    const count = Math.round(CONSONANT_SEC * sampleRate);
    for (let i = 0; i < count && first + i < out.length; i++) {
      const decay = Math.exp((-3 * i) / count);
      out[first + i] = (out[first + i] as number) + (random() * 2 - 1) * 0.5 * (s.level ?? 0.3) * 2 * decay;
    }
  }
  return out;
}

/** The time a syllable's attack is heard at: the first moment the 2.5 ms envelope passes a fifth of its peak near `aroundSec`. */
export function attackTime(x: Float32Array, sampleRate: number, aroundSec: number, spanSec = 0.12): number {
  const from = Math.max(0, Math.floor((aroundSec - spanSec) * sampleRate));
  const to = Math.min(x.length, Math.ceil((aroundSec + spanSec) * sampleRate));
  const width = Math.max(1, Math.round(0.0025 * sampleRate));
  const envelope: number[] = [];
  let running = 0;
  for (let i = from; i < to; i++) {
    running += Math.abs(x[i] as number);
    if (i - from >= width) running -= Math.abs(x[i - width] as number);
    envelope.push(running / width);
  }
  const peak = Math.max(...envelope);
  const first = envelope.findIndex((v) => v >= 0.2 * peak);
  return (from + first) / sampleRate;
}
