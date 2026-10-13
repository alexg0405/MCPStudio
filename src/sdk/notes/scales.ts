/**
 * Scales and keys: membership, snapping and scale-degree math. Keys are MIDI note numbers (0–127,
 * 60 = FL's C5); roots are pitch classes (0 = C … 11 = B). Pure functions, no DOM.
 */

/** Pitch-class names with sharps (index = pitch class), as FL Studio writes them. */
export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface Scale {
  /** Stable id stored in projects (`transport.key.scale`). */
  readonly id: string;
  readonly label: string;
  /** Semitones above the root in ascending order: starts with 0, every value < 12. */
  readonly intervals: readonly number[];
}

/** A song key as the host passes it to note scripts (`ctx.key`) and stores it (`transport.key`). */
export interface KeyLike {
  /** Pitch class of the tonic, 0 (C) – 11 (B). */
  readonly root: number;
  /** A scale id from `SCALES`; unknown ids read as major. */
  readonly scale: string;
}

/** Every scale the piano roll offers, most common first. */
export const SCALES: readonly Scale[] = [
  { id: 'major', label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic-minor', label: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor', label: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', label: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'major-pentatonic', label: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'major-blues', label: 'Major blues', intervals: [0, 2, 3, 4, 7, 9] },
  { id: 'phrygian-dominant', label: 'Phrygian dominant', intervals: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'harmonic-major', label: 'Harmonic major', intervals: [0, 2, 4, 5, 7, 8, 11] },
  { id: 'double-harmonic', label: 'Double harmonic', intervals: [0, 1, 4, 5, 7, 8, 11] },
  { id: 'hungarian-minor', label: 'Hungarian minor', intervals: [0, 2, 3, 6, 7, 8, 11] },
  { id: 'hirajoshi', label: 'Hirajoshi', intervals: [0, 2, 3, 7, 8] },
  { id: 'in-sen', label: 'In-sen', intervals: [0, 1, 5, 7, 10] },
  { id: 'whole-tone', label: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10] },
  { id: 'diminished', label: 'Diminished (whole-half)', intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: 'chromatic', label: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

const BY_ID = new Map(SCALES.map((s) => [s.id, s]));
const MAJOR = SCALES[0] as Scale;

/** The scale with this id; unknown ids give the major scale. */
export function getScale(id: string): Scale {
  return BY_ID.get(id) ?? MAJOR;
}

export function isScaleId(id: string): boolean {
  return BY_ID.has(id);
}

/** Pitch class 0–11 of any integer key (negative keys too). */
export function pitchClass(key: number): number {
  return ((Math.round(key) % 12) + 12) % 12;
}

// Per scale: pitch class relative to the root → index of the scale note at or below it.
const floorIndex = new Map<string, Int8Array>();

function floors(scale: Scale): Int8Array {
  let table = floorIndex.get(scale.id);
  if (!table) {
    table = new Int8Array(12);
    let i = 0;
    for (let pc = 0; pc < 12; pc++) {
      while (i + 1 < scale.intervals.length && (scale.intervals[i + 1] as number) <= pc) i++;
      table[pc] = i;
    }
    floorIndex.set(scale.id, table);
  }
  return table;
}

/** Which pitch classes (index = key % 12) belong to the scale. */
export function scaleMask(root: number, scaleId: string): boolean[] {
  const mask = new Array<boolean>(12).fill(false);
  for (const i of getScale(scaleId).intervals) mask[pitchClass(root + i)] = true;
  return mask;
}

export function inScale(key: number, root: number, scaleId: string): boolean {
  return getScale(scaleId).intervals.includes(pitchClass(key - root));
}

/** The scale's keys between `low` and `high` (inclusive), ascending. */
export function scaleNotes(root: number, scaleId: string, low = 0, high = 127): number[] {
  const mask = scaleMask(root, scaleId);
  const out: number[] = [];
  for (let k = Math.ceil(low); k <= high; k++) if (mask[pitchClass(k)]) out.push(k);
  return out;
}

/**
 * Absolute scale step of a key: counts scale notes from the root's lowest octave (key `root % 12` is
 * step 0). A key outside the scale gets the step of the scale note just below it.
 */
export function scaleStep(key: number, root: number, scaleId: string): number {
  const scale = getScale(scaleId);
  const rel = Math.round(key) - pitchClass(root);
  const octave = Math.floor(rel / 12);
  return octave * scale.intervals.length + (floors(scale)[rel - octave * 12] as number);
}

/** The key of an absolute scale step (inverse of `scaleStep` for keys in the scale). */
export function keyAtStep(step: number, root: number, scaleId: string): number {
  const { intervals } = getScale(scaleId);
  const s = Math.round(step);
  const octave = Math.floor(s / intervals.length);
  return pitchClass(root) + octave * 12 + (intervals[s - octave * intervals.length] as number);
}

/** The scale degree of a key (0 = the root, 1 = the second, …), or null when it isn't in the scale. */
export function scaleDegree(key: number, root: number, scaleId: string): number | null {
  const i = getScale(scaleId).intervals.indexOf(pitchClass(key - root));
  return i < 0 ? null : i;
}

/**
 * Moves a key by scale steps (+2 = up a third in the scale). Keys outside the scale keep their
 * distance above the scale note below them. Not range-limited: the result can leave 0–127.
 */
export function transposeInScale(key: number, steps: number, root: number, scaleId: string): number {
  const step = scaleStep(key, root, scaleId);
  const offset = Math.round(key) - keyAtStep(step, root, scaleId);
  return keyAtStep(step + Math.round(steps), root, scaleId) + offset;
}

/**
 * The scale note nearest to `key` ('nearest': ties go down), or the next one at or above / at or
 * below it. Stays within 0–127 (it picks the other direction at the edges).
 */
export function snapToScale(
  key: number,
  root: number,
  scaleId: string,
  direction: 'nearest' | 'up' | 'down' = 'nearest',
): number {
  const k = Math.max(0, Math.min(127, Math.round(key)));
  if (inScale(k, root, scaleId)) return k;
  const step = scaleStep(k, root, scaleId);
  const down = keyAtStep(step, root, scaleId);
  const up = keyAtStep(step + 1, root, scaleId);
  let pick = direction === 'up' ? up : direction === 'down' ? down : k - down <= up - k ? down : up;
  if (pick > 127) pick = down;
  if (pick < 0) pick = up;
  return pick;
}

/** FL-style note name: 60 = "C5" (FL numbers octaves one higher than scientific pitch). */
export function noteName(key: number): string {
  const k = Math.round(key);
  return `${PITCH_NAMES[pitchClass(k)]}${Math.floor(k / 12)}`;
}

/** "C# minor", "F major pentatonic", "D dorian". */
export function keyLabel(root: number, scaleId: string): string {
  return `${PITCH_NAMES[pitchClass(root)]} ${getScale(scaleId).label.toLowerCase()}`;
}
