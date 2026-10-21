/**
 * What editing on the sheet means for the notes underneath, as plain data: the new key of a note moved by a scale step, a
 * semitone or an octave, the length a duration key gives, and the note a letter key puts at the cursor. The app turns
 * these into History edits (one undo step each), so the piano roll shows the same change.
 */
import type { Tick } from '../model/types';
import { ticksOfValue, VALUE_LETTERS } from './durations';
import { keySignatureOf, signatureAlter, stepInKey } from './spelling';
import type { NoteValue, Step } from './types';

type SongKeyLike = { root: number; scale: string } | undefined;

/** How far a pitch key moves: a step of the song's scale, a semitone or an octave. */
export type PitchMove = 'scale' | 'semitone' | 'octave';

const SEMITONES_PER_OCTAVE = 12;

/** The key a note has after moving `direction` (1 up, -1 down) by `move`; the same key when it cannot go further. */
export function movedKey(key: number, direction: 1 | -1, move: PitchMove, songKey: SongKeyLike): number {
  if (move === 'scale') return stepInKey(key, direction, songKey);
  const distance = move === 'octave' ? SEMITONES_PER_OCTAVE : 1;
  const next = key + direction * distance;
  return next < 0 || next > 127 ? key : next;
}

/** The input duration of the keyboard: a value, with a dot or a triplet. */
export interface EntryDuration {
  base: Exclude<NoteValue['base'], 64>;
  isDotted: boolean;
  isTriplet: boolean;
}

/** The length in ticks of an entry duration: dotted is half again, a triplet two thirds. */
export function entryTicks(duration: EntryDuration): Tick {
  const plain = ticksOfValue({ base: duration.base, dots: duration.isDotted ? 1 : 0 });
  return duration.isTriplet ? Math.round((plain * 2) / 3) : plain;
}

/** The number key that picks each value: 1 whole, 2 half, 4 quarter, 8 eighth, 6 sixteenth, 3 thirty-second. */
export const DURATION_KEYS: Readonly<Record<string, EntryDuration['base']>> = { '1': 1, '2': 2, '4': 4, '8': 8, '6': 16, '3': 32 };

/** "quarter note", "dotted eighth triplet" as the toolbar and the announcements say it. */
export function entryName(duration: EntryDuration): string {
  const names: Record<NoteValue['base'], string> = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: 'sixteenth', 32: 'thirty-second', 64: 'sixty-fourth' };
  return `${duration.isDotted ? 'dotted ' : ''}${names[duration.base]}${duration.isTriplet ? ' triplet' : ' note'}`;
}

/** The letter of a value in the compact text ("q"), for the toolbar's short label. */
export const entryLetter = (duration: EntryDuration): string => `${VALUE_LETTERS[duration.base]}${duration.isDotted ? '.' : ''}${duration.isTriplet ? '3' : ''}`;

const LETTER_PITCH_CLASS: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTER_STEPS: Readonly<Record<string, Step>> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/**
 * The key a typed letter means: the letter with the song key's sharps or flats (an F in G major is F sharp), moved by
 * `accidental` (+1 for a typed "#", -1 for "b"), in the octave nearest to `reference` (the last note: a melody climbs and
 * falls in steps, not leaps).
 */
export function keyForLetter(letter: string, accidental: number, songKey: SongKeyLike, reference: number): number | null {
  const name = letter.toUpperCase();
  const base = LETTER_PITCH_CLASS[name];
  const step = LETTER_STEPS[name];
  if (base === undefined || step === undefined) return null;
  const sign = keySignatureOf(songKey);
  const pitchClass = (((base + signatureAlter(sign.fifths, step) + accidental) % 12) + 12) % 12;
  let best = -1;
  for (let octave = 0; octave < 11; octave++) {
    const candidate = octave * 12 + pitchClass;
    if (candidate > 127) continue;
    if (best < 0 || Math.abs(candidate - reference) < Math.abs(best - reference)) best = candidate;
  }
  return best < 0 ? null : best;
}
