/**
 * Writing pitches the way a score does: the key signature of the song key, which letter and accidental a MIDI key
 * gets in that key (C sharp or D flat), and where on the staff it sits. Middle C (MIDI 60) is C4 here.
 */
import { harmonicScale, keyMode } from '../harmony/scale';
import type { AccidentalSign, KeySignature, Spelling, Step } from './types';

/** Pitch class of each letter C D E F G A B. */
const LETTER_PITCH_CLASS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
/** Where each letter sits on the line of fifths (F -1, C 0, G 1, D 2, A 3, E 4, B 5): the order sharps and flats arrive in. */
const LETTER_FIFTHS: readonly number[] = [0, 2, 4, -1, 1, 3, 5];
/** The letters in line-of-fifths order starting at F. */
const FIFTHS_LETTERS: readonly Step[] = [3, 0, 4, 1, 5, 2, 6];

/** Sharps or flats of the major key on each tonic (0 = C). A tonic with two spellings takes the one with fewer signs. */
const MAJOR_FIFTHS: readonly number[] = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];

/** For each scale: how many fifths the tonic is above the tonic of the major key with the same notes, and the semitones up to that major tonic. */
const MODE_SHIFT: Readonly<Record<string, { fifths: number; semitonesToMajor: number }>> = {
  major: { fifths: 0, semitonesToMajor: 0 },
  minor: { fifths: 3, semitonesToMajor: 3 },
  dorian: { fifths: 2, semitonesToMajor: 10 },
  phrygian: { fifths: 4, semitonesToMajor: 8 },
  lydian: { fifths: -1, semitonesToMajor: 7 },
  mixolydian: { fifths: 1, semitonesToMajor: 5 },
  locrian: { fifths: 5, semitonesToMajor: 1 },
};

const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

/** The key signature for the song key (C major, no signs, when there is none). Scales that are not modes use the signature of their parent. */
export function keySignatureOf(key: { root: number; scale: string } | undefined): KeySignature {
  if (!key) return { fifths: 0, name: 'C major' };
  const mode = MODE_SHIFT[key.scale] ?? MODE_SHIFT[keyMode(key.scale) === 'minor' ? 'minor' : 'major'];
  const shift = mode as { fifths: number; semitonesToMajor: number };
  const majorTonic = mod12(key.root + shift.semitonesToMajor);
  const fifths = MAJOR_FIFTHS[majorTonic] as number;
  const tonic = spellFifths(fifths + shift.fifths);
  const sign = tonic.alter > 0 ? '#' : tonic.alter < 0 ? 'b' : '';
  const scaleName = MODE_SHIFT[key.scale] ? key.scale : keyMode(key.scale) === 'minor' ? 'minor' : 'major';
  return { fifths, name: `${LETTER_NAMES[tonic.step]}${sign} ${scaleName}` };
}

/** The letter and accidental at a place on the line of fifths (0 = C, 1 = G, -1 = F, 6 = F sharp). */
function spellFifths(position: number): { step: Step; alter: number } {
  const index = (((position + 1) % 7) + 7) % 7;
  return { step: FIFTHS_LETTERS[index] as Step, alter: Math.floor((position + 1) / 7) };
}

/** What the key signature does to a letter: 1 sharp, -1 flat, 0 nothing. */
export function signatureAlter(fifths: number, step: Step): number {
  const place = LETTER_FIFTHS[step] as number;
  if (place <= fifths - 2) return 1;
  if (place >= fifths + 6) return -1;
  return 0;
}

/** How a note outside the key and its scale is spelled in a key with no signs. */
const CHROMATIC_NO_SIGNS: ReadonlyArray<{ step: Step; alter: number }> = [
  { step: 0, alter: 0 },
  { step: 0, alter: 1 },
  { step: 1, alter: 0 },
  { step: 2, alter: -1 },
  { step: 2, alter: 0 },
  { step: 3, alter: 0 },
  { step: 3, alter: 1 },
  { step: 4, alter: 0 },
  { step: 4, alter: 1 },
  { step: 5, alter: 0 },
  { step: 6, alter: -1 },
  { step: 6, alter: 0 },
];

/** Letter and accidental for a pitch class as a spelling that needs no octave yet. */
function spellPitchClass(pitchClass: number, key: { root: number; scale: string } | undefined, fifths: number): { step: Step; alter: number } {
  // 1. A note of the key signature's own scale (the diatonic notes) is spelled as the signature says.
  for (let step = 0 as Step; step < 7; step = (step + 1) as Step) {
    const alter = signatureAlter(fifths, step);
    if (mod12((LETTER_PITCH_CLASS[step] as number) + alter) === pitchClass) return { step, alter };
  }
  // 2. A note of the key's own scale outside the signature (the raised seventh of the harmonic minor): the letters follow the scale.
  const scaled = key ? spellInScale(pitchClass, key) : null;
  if (scaled) return scaled;
  // 3. A white key outside the key is written natural (the F natural in G major); a black key leans the way the signature does.
  const natural = LETTER_PITCH_CLASS.indexOf(pitchClass);
  if (natural >= 0) return { step: natural as Step, alter: 0 };
  if (fifths > 0) return sharpSpelling(pitchClass);
  if (fifths < 0) return flatSpelling(pitchClass);
  return CHROMATIC_NO_SIGNS[pitchClass] as { step: Step; alter: number };
}

function sharpSpelling(pitchClass: number): { step: Step; alter: number } {
  for (const step of [0, 1, 2, 3, 4, 5, 6] as const) {
    const natural = LETTER_PITCH_CLASS[step] as number;
    if (natural === pitchClass) return { step, alter: 0 };
    if (mod12(natural + 1) === pitchClass) return { step, alter: 1 };
  }
  return { step: 0, alter: 0 };
}

function flatSpelling(pitchClass: number): { step: Step; alter: number } {
  for (const step of [0, 1, 2, 3, 4, 5, 6] as const) {
    const natural = LETTER_PITCH_CLASS[step] as number;
    if (natural === pitchClass) return { step, alter: 0 };
    if (mod12(natural - 1) === pitchClass) return { step, alter: -1 };
  }
  return { step: 0, alter: 0 };
}

/** The letter of a pitch that is in a seven-note scale of the key: one letter per scale degree, starting at the tonic's letter. */
function spellInScale(pitchClass: number, key: { root: number; scale: string }): { step: Step; alter: number } | null {
  const intervals = harmonicScale(key.scale);
  const degree = intervals.findIndex((interval) => mod12(key.root + interval) === pitchClass);
  if (degree < 0) return null;
  const tonic = tonicSpelling(key);
  const step = ((tonic.step + degree) % 7) as Step;
  let alter = pitchClass - (LETTER_PITCH_CLASS[step] as number);
  while (alter > 6) alter -= 12;
  while (alter < -6) alter += 12;
  return Math.abs(alter) <= 2 ? { step, alter } : null;
}

/** The tonic of the song key as a letter and accidental. */
function tonicSpelling(key: { root: number; scale: string }): { step: Step; alter: number } {
  const mode = MODE_SHIFT[key.scale] ?? MODE_SHIFT[keyMode(key.scale) === 'minor' ? 'minor' : 'major'];
  const shift = mode as { fifths: number; semitonesToMajor: number };
  const fifths = MAJOR_FIFTHS[mod12(key.root + shift.semitonesToMajor)] as number;
  return spellFifths(fifths + shift.fifths);
}

/** Writes a MIDI key as a letter, accidental and octave in this key. */
export function spellKey(key: number, songKey: { root: number; scale: string } | undefined, signature: KeySignature): Spelling {
  const midi = Math.round(key);
  const written = spellPitchClass(mod12(midi), songKey, signature.fifths);
  return { step: written.step, alter: written.alter, octave: Math.floor((midi - written.alter) / 12) - 1 };
}

/** The MIDI key a spelling stands for. */
export function keyOfSpelling(spelling: Spelling): number {
  return (spelling.octave + 1) * 12 + (LETTER_PITCH_CLASS[spelling.step] as number) + spelling.alter;
}

/** The diatonic position: octave * 7 + letter (E4 = 30). Two notes a second apart differ by one. */
export function positionOf(spelling: Spelling): number {
  return spelling.octave * 7 + spelling.step;
}

/** "C#4", "Bb3", "E5": the name used in the compact text and in speech ("C sharp 4"). */
export function spellingName(spelling: Spelling, options: { spoken?: boolean } = {}): string {
  const letter = LETTER_NAMES[spelling.step];
  if (options.spoken) {
    const word = spelling.alter === 0 ? '' : spelling.alter === 1 ? ' sharp' : spelling.alter === -1 ? ' flat' : spelling.alter === 2 ? ' double sharp' : ' double flat';
    return `${letter}${word} ${spelling.octave}`;
  }
  const sign = spelling.alter === 0 ? '' : spelling.alter === 1 ? '#' : spelling.alter === -1 ? 'b' : spelling.alter === 2 ? '##' : 'bb';
  return `${letter}${sign}${spelling.octave}`;
}

/** The sign that shows an alteration (null for none). */
export function accidentalSign(alter: number): AccidentalSign | null {
  if (alter === 1) return 'sharp';
  if (alter === -1) return 'flat';
  if (alter === 2) return 'double-sharp';
  if (alter === -2) return 'double-flat';
  return null;
}

/** The letter 0 (C) to 6 (B) and its name. */
export const stepLetter = (step: Step): string => LETTER_NAMES[step] as string;

/**
 * The key a given number of diatonic steps above this one in the song key's seven-note scale (negative = below). A note
 * outside the scale first moves to the next scale note in the direction of travel. With no key it is C major.
 */
export function stepInKey(key: number, steps: number, songKey: { root: number; scale: string } | undefined): number {
  if (steps === 0) return key;
  const root = songKey?.root ?? 0;
  const scale = harmonicScale(songKey?.scale ?? 'major');
  const notes: number[] = [];
  for (let octave = -1; octave < 12; octave++) for (const interval of scale) notes.push(octave * 12 + mod12(root) + interval);
  notes.sort((a, b) => a - b);
  const onScale = notes.indexOf(key);
  let index: number;
  if (onScale >= 0) index = onScale + steps;
  else if (steps > 0) index = notes.findIndex((note) => note > key) + steps - 1;
  else index = notes.filter((note) => note < key).length - 1 + steps + 1;
  return Math.max(0, Math.min(127, notes[Math.max(0, Math.min(notes.length - 1, index))] as number));
}
