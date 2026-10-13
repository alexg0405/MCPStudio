/**
 * Pure helpers for drawing in key: the chord stamp, snapping drawn keys to the song's scale and
 * moving notes by scale steps. Kept apart from the controller so they're unit-tested in Node.
 */
import {
  CHORDS,
  chordNotes,
  detectChord,
  diatonicChord,
  isChordId,
  scaleStep,
  snapToScale,
  transposeInScale,
} from '@agstudio/sdk/notes';
import type { SongKey } from '@core/model/types';

const C_MAJOR: SongKey = { root: 0, scale: 'major' };

/** Chord stamp choices for the toolbar: value '' = single notes. Labels show the chord on C. */
export const STAMP_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Off (single notes)' },
  { value: 'diatonic', label: 'In key: triads' },
  { value: 'diatonic7', label: 'In key: 7th chords' },
  ...CHORDS.map((c) => ({ value: c.id, label: `${c.label} (C${c.symbol})` })),
];

/** The name of the chord some keys form ("Cm7", "G/B"), or '' when it has none. */
export function stampName(keys: readonly number[]): string {
  return keys.length > 1 ? (detectChord(keys)?.name ?? '') : '';
}

/** The keys that drawing at `key` creates: the chord stamp on it, or the key alone. */
export function stampKeys(key: number, chord: string, inversion: number, songKey: SongKey | null): number[] {
  if (chord === 'diatonic' || chord === 'diatonic7') {
    const k = songKey ?? C_MAJOR;
    return diatonicChord(key, k.root, k.scale, chord === 'diatonic7' ? 4 : 3, { inversion });
  }
  if (!chord || !isChordId(chord)) return [key];
  return chordNotes(key, chord, { inversion });
}

/** The key a drawn note gets: the key under the pointer, snapped to the scale when snapping is on. */
export function drawKey(key: number, scaleSnap: boolean, songKey: SongKey | null): number {
  return scaleSnap && songKey ? snapToScale(key, songKey.root, songKey.scale) : key;
}

/**
 * New keys for notes dragged vertically from `fromKey` to the pointer's `toKey`. Normally every
 * note moves by the same semitones; snapping to the scale moves them by scale steps so a melody
 * stays in key. The move shrinks rather than push a note out of 0–127.
 */
export function movedKeys(
  keys: readonly number[],
  fromKey: number,
  toKey: number,
  scaleSnap: boolean,
  songKey: SongKey | null,
): number[] {
  if (keys.length === 0) return [];
  if (!scaleSnap || !songKey) {
    const lo = Math.min(...keys);
    const hi = Math.max(...keys);
    const by = Math.max(-lo, Math.min(127 - hi, toKey - fromKey));
    return keys.map((k) => k + by);
  }
  const { root, scale } = songKey;
  const target = snapToScale(toKey, root, scale);
  const steps = scaleStep(target, root, scale) - scaleStep(fromKey, root, scale);
  for (let m = steps; ; m -= Math.sign(m)) {
    const out = keys.map((k) => transposeInScale(k, m, root, scale));
    if (m === 0 || out.every((k) => k >= 0 && k <= 127)) return out;
  }
}
