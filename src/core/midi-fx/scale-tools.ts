/**
 * Scales and chords as the MIDI effects need them: which pitch classes are allowed, the nearest allowed key, and moving a key by
 * steps of the scale. Core may not import the SDK's note theory, so this builds on the harmony tables core already has.
 */
import { chordPitchClasses, mod12, type ChordSymbol } from '../harmony/chord';
import { scalePitchClasses, type KeyLike } from '../harmony/scale';
import { MAX_KEY, MIN_KEY } from './note-utils';

/** The scales the Scale effect and the chord effect can use besides the song key: ids match the SDK's and the piano roll's. */
export const SCALE_IDS: readonly string[] = [
  'major',
  'minor',
  'harmonic-minor',
  'melodic-minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
  'major-pentatonic',
  'minor-pentatonic',
  'blues',
  'whole-tone',
  'phrygian-dominant',
  'chromatic',
];

/** A scale id as a plain label ("harmonic-minor" reads "Harmonic minor"). */
export function scaleLabel(id: string): string {
  const words = id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which of the twelve pitch classes are allowed. */
export type PitchMask = readonly boolean[];

/** A mask from a list of pitch classes. */
export function maskOf(pitchClasses: readonly number[]): PitchMask {
  const mask = new Array<boolean>(12).fill(false);
  for (const pitchClass of pitchClasses) mask[mod12(pitchClass)] = true;
  return mask;
}

/** The pitch classes a chord holds (its bass too, for a slash chord). */
export function chordMask(chord: ChordSymbol): PitchMask {
  const classes = chordPitchClasses(chord);
  if (chord.bass !== undefined) classes.push(mod12(chord.bass));
  return maskOf(classes);
}

/** The notes of a key's scale as a mask. */
export function keyMask(key: KeyLike): PitchMask {
  return maskOf(scalePitchClasses(key));
}

/** How `snapKey` picks between two allowed keys: the nearest one (a tie goes down), or always the one above or below. */
export type SnapDirection = 'nearest' | 'up' | 'down';

/**
 * The allowed key nearest to `key` in the direction asked for, or null when no key of that direction is allowed and in
 * range (an empty mask, or nothing allowed above the top key).
 */
export function snapKey(key: number, mask: PitchMask, direction: SnapDirection): number | null {
  for (let distance = 0; distance <= 12; distance++) {
    const below = key - distance;
    const above = key + distance;
    const canGoDown = direction !== 'up';
    const canGoUp = direction !== 'down';
    if (canGoDown && below >= MIN_KEY && mask[mod12(below)]) return below;
    if (canGoUp && above <= MAX_KEY && mask[mod12(above)]) return above;
  }
  return null;
}

/** A key's scale degrees as semitones above its root, ascending (a major key is 0 2 4 5 7 9 11). */
export function scaleSteps(key: KeyLike): number[] {
  return scalePitchClasses(key)
    .map((pitchClass) => mod12(pitchClass - key.root))
    .sort((a, b) => a - b);
}

/**
 * The key `steps` degrees of the scale above `key` (below for a negative number). A key outside the scale is first moved to the
 * nearest note of it, so a chord built on it stays in the key. Null when the result is not a playable key.
 */
export function stepInScale(key: number, steps: number, scale: KeyLike): number | null {
  const degrees = scaleSteps(scale);
  const inScale = snapKey(key, keyMask(scale), 'nearest');
  if (inScale === null || degrees.length === 0) return null;
  const root = mod12(scale.root);
  const octave = Math.floor((inScale - root) / 12);
  const degree = degrees.indexOf(mod12(inScale - root));
  const absolute = octave * degrees.length + degree + steps;
  const wrapped = ((absolute % degrees.length) + degrees.length) % degrees.length;
  const result = root + Math.floor(absolute / degrees.length) * 12 + (degrees[wrapped] as number);
  return result >= MIN_KEY && result <= MAX_KEY ? result : null;
}
