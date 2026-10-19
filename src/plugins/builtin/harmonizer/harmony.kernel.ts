// Which notes the harmony voices sing. Pure number code with no allocation, so the audio thread can call it
// for every pitch estimate: the scale maths for "a third above in this key" and the picking of held guide notes.

/** Largest shift one voice makes, semitones either way (the shifter's splice window is built for one octave). */
export const MAX_SHIFT_SEMITONES = 12;

/** Keep the current note until another is this much (semitones) nearer: no flicker between two notes. */
export const HYSTERESIS = 0.2;

/** Semitones either side of a pitch that the nearest-note search looks through (half an octave). */
const SEARCH_SEMITONES = 6;

/** A scale as a pitch-class mask: bit n is set for the note n semitones above the root. */
export function scaleMaskOf(intervals: readonly number[]): number {
  let mask = 0;
  for (let i = 0; i < intervals.length; i++) mask |= 1 << (intervals[i] as number);
  return mask;
}

/** Semitones from the root of the key up to `note`, from 0 to 11. */
function semitonesAboveRoot(note: number, rootPitchClass: number): number {
  return (((note - rootPitchClass) % 12) + 12) % 12;
}

/**
 * The note of the key and scale nearest to a pitch (fractional MIDI note), keeping `currentNote` while it is
 * within HYSTERESIS of being as near (-1 for none).
 */
export function nearestScaleNote(pitchMidi: number, rootPitchClass: number, scaleMask: number, currentNote: number): number {
  let bestNote = -1;
  let bestDistance = Infinity;
  const nearestWhole = Math.round(pitchMidi);
  for (let note = nearestWhole - SEARCH_SEMITONES; note <= nearestWhole + SEARCH_SEMITONES; note++) {
    if (!(scaleMask & (1 << semitonesAboveRoot(note, rootPitchClass)))) continue;
    const distance = Math.abs(pitchMidi - note);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNote = note;
    }
  }
  if (currentNote < 0 || bestNote === currentNote) return bestNote;
  const isInScale = scaleMask & (1 << semitonesAboveRoot(currentNote, rootPitchClass));
  if (isInScale && Math.abs(pitchMidi - currentNote) <= bestDistance + HYSTERESIS) return currentNote;
  return bestNote;
}

/**
 * How many semitones a note of the scale moves when it goes `steps` notes up the scale (down for a negative
 * number): a third above is 2 steps, a fifth 4, an octave 7 (in a seven-note scale). `scaleNote` must be a note of
 * the scale; one that is not is treated as the scale note just below it.
 */
export function scaleStepSemitones(
  scaleNote: number,
  rootPitchClass: number,
  scaleIntervals: readonly number[],
  steps: number,
): number {
  const offset = semitonesAboveRoot(scaleNote, rootPitchClass);
  let degree = 0;
  while (degree + 1 < scaleIntervals.length && (scaleIntervals[degree + 1] as number) <= offset) degree++;
  const targetDegree = degree + steps;
  const octaves = Math.floor(targetDegree / scaleIntervals.length);
  const targetIndex = targetDegree - octaves * scaleIntervals.length;
  return 12 * octaves + (scaleIntervals[targetIndex] as number) - (scaleIntervals[degree] as number);
}

/** A shift limited to what the shifter can do, MAX_SHIFT_SEMITONES either way. */
export function limitShift(semitones: number): number {
  if (semitones > MAX_SHIFT_SEMITONES) return MAX_SHIFT_SEMITONES;
  if (semitones < -MAX_SHIFT_SEMITONES) return -MAX_SHIFT_SEMITONES;
  return semitones;
}

// ---- Guide notes ----

/**
 * The held key nearest to a pitch (fractional MIDI), keeping `currentKey` while it is still held and within
 * HYSTERESIS of being as near (-1: nothing held). The lower key wins a tie.
 */
export function nearestHeldKey(heldKeys: Int16Array, heldCount: number, pitchMidi: number, currentKey: number): number {
  let bestKey = -1;
  let bestDistance = Infinity;
  let isCurrentHeld = false;
  for (let i = 0; i < heldCount; i++) {
    const heldKey = heldKeys[i] as number;
    if (heldKey === currentKey) isCurrentHeld = true;
    const distance = Math.abs(pitchMidi - heldKey);
    if (distance < bestDistance || (distance === bestDistance && heldKey < bestKey)) {
      bestDistance = distance;
      bestKey = heldKey;
    }
  }
  if (isCurrentHeld && bestKey !== currentKey && Math.abs(pitchMidi - currentKey) <= bestDistance + HYSTERESIS)
    return currentKey;
  return bestKey;
}

/**
 * The next held key above `key` (or a held pitch class moved up whole octaves when none is higher: with a
 * chord held, the voice above the top note sings the chord's lowest note an octave up). -1 when nothing is held.
 */
export function heldKeyAbove(heldKeys: Int16Array, heldCount: number, key: number): number {
  let above = -1;
  let lowest = -1;
  for (let i = 0; i < heldCount; i++) {
    const heldKey = heldKeys[i] as number;
    if (lowest < 0 || heldKey < lowest) lowest = heldKey;
    if (heldKey > key && (above < 0 || heldKey < above)) above = heldKey;
  }
  if (above >= 0 || lowest < 0) return above;
  let wrapped = lowest;
  while (wrapped <= key) wrapped += 12;
  return wrapped;
}

/** The next held key below `key`, or the chord's highest note moved down whole octaves when none is lower (-1: nothing held). */
export function heldKeyBelow(heldKeys: Int16Array, heldCount: number, key: number): number {
  let below = -1;
  let highest = -1;
  for (let i = 0; i < heldCount; i++) {
    const heldKey = heldKeys[i] as number;
    if (heldKey > highest) highest = heldKey;
    if (heldKey < key && heldKey > below) below = heldKey;
  }
  if (below >= 0 || highest < 0) return below;
  let wrapped = highest;
  while (wrapped >= key) wrapped -= 12;
  return wrapped;
}

/** `note` moved by whole octaves to within MAX_SHIFT_SEMITONES of the pitch, so the voice never has to shift further than it can. */
export function foldNearPitch(note: number, pitchMidi: number): number {
  let folded = note;
  while (folded - pitchMidi > MAX_SHIFT_SEMITONES) folded -= 12;
  while (pitchMidi - folded > MAX_SHIFT_SEMITONES) folded += 12;
  return folded;
}
