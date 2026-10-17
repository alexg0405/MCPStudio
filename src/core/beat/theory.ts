/** Chords and bass keys the offline generator writes with (`local.ts`, `local-edm.ts`). */
import type { BeatNote } from './spec';
import { STEPS_PER_BAR } from './spec';

export type Quality = 'maj' | 'min' | 'maj7' | 'm7' | '7';
export const CHORD: Record<Quality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  '7': [0, 4, 7, 10],
};

/** A progression: chord roots in semitones above the key's root, and their qualities. */
export type Progression = readonly (readonly [number, Quality])[];

/** A synth bass key kept at B2 or below (its sub plays an octave under it). */
export const bassKey = (key: number) => (key > 47 ? key - 12 : key);

/** A chord of `quality` on `root` (pitch class) voiced with its root between `low` and `low + 11`. */
export function voice(root: number, quality: Quality, low = 48): number[] {
  const base = low + ((((root - low) % 12) + 12) % 12);
  return CHORD[quality].map((i) => base + i);
}

/**
 * A chord per bar for `bars` bars; `hits` are [step, length, velocity] within each bar (a held
 * chord, or a lazy re-strike for keys).
 */
export function chords(
  progression: Progression,
  keyRoot: number,
  bars: number,
  hits: readonly (readonly [number, number, number])[],
  low = 48,
): BeatNote[] {
  const notes: BeatNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const [degree, quality] = progression[bar % progression.length]!;
    const keys = voice(keyRoot + degree, quality, low);
    for (const [step, len, vel] of hits)
      for (const key of keys) notes.push({ step: bar * STEPS_PER_BAR + step, len, key, vel });
  }
  return notes;
}
