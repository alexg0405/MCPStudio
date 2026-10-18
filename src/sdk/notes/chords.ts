/**
 * Chords: definitions from power chords to 13ths, inversions, voicings, chords built from a scale
 * (diatonic) and chord recognition. Keys are MIDI note numbers (0–127).
 */
import { getScale, keyAtStep, PITCH_NAMES, pitchClass, scaleStep } from './scales';

/** A chord quality: its id, label, symbol and the semitones above the root. */
export interface Chord {
  /** Stable id (used by note scripts and the piano roll's chord stamp). */
  readonly id: string;
  readonly label: string;
  /** Written after the root: "m7" → Cm7. */
  readonly symbol: string;
  /** Semitones above the root, ascending (may exceed an octave for 9ths and up). */
  readonly intervals: readonly number[];
}

/** Every chord quality the SDK knows. */
export const CHORDS: readonly Chord[] = [
  { id: 'major', label: 'Major', symbol: '', intervals: [0, 4, 7] },
  { id: 'minor', label: 'Minor', symbol: 'm', intervals: [0, 3, 7] },
  { id: 'dim', label: 'Diminished', symbol: 'dim', intervals: [0, 3, 6] },
  { id: 'aug', label: 'Augmented', symbol: 'aug', intervals: [0, 4, 8] },
  { id: 'sus2', label: 'Suspended 2nd', symbol: 'sus2', intervals: [0, 2, 7] },
  { id: 'sus4', label: 'Suspended 4th', symbol: 'sus4', intervals: [0, 5, 7] },
  { id: 'power', label: 'Power chord', symbol: '5', intervals: [0, 7] },
  { id: 'power8', label: 'Power chord + octave', symbol: '5(8)', intervals: [0, 7, 12] },
  { id: '6', label: 'Major 6th', symbol: '6', intervals: [0, 4, 7, 9] },
  { id: 'm6', label: 'Minor 6th', symbol: 'm6', intervals: [0, 3, 7, 9] },
  { id: '7', label: 'Dominant 7th', symbol: '7', intervals: [0, 4, 7, 10] },
  { id: 'maj7', label: 'Major 7th', symbol: 'maj7', intervals: [0, 4, 7, 11] },
  { id: 'm7', label: 'Minor 7th', symbol: 'm7', intervals: [0, 3, 7, 10] },
  { id: 'mmaj7', label: 'Minor major 7th', symbol: 'm(maj7)', intervals: [0, 3, 7, 11] },
  { id: 'm7b5', label: 'Half-diminished 7th', symbol: 'm7b5', intervals: [0, 3, 6, 10] },
  { id: 'dim7', label: 'Diminished 7th', symbol: 'dim7', intervals: [0, 3, 6, 9] },
  { id: 'aug7', label: 'Augmented 7th', symbol: 'aug7', intervals: [0, 4, 8, 10] },
  { id: '7sus4', label: '7th suspended 4th', symbol: '7sus4', intervals: [0, 5, 7, 10] },
  { id: 'add9', label: 'Add 9', symbol: 'add9', intervals: [0, 4, 7, 14] },
  { id: 'madd9', label: 'Minor add 9', symbol: 'madd9', intervals: [0, 3, 7, 14] },
  { id: '6-9', label: '6/9', symbol: '6/9', intervals: [0, 4, 7, 9, 14] },
  { id: '9', label: 'Dominant 9th', symbol: '9', intervals: [0, 4, 7, 10, 14] },
  { id: 'maj9', label: 'Major 9th', symbol: 'maj9', intervals: [0, 4, 7, 11, 14] },
  { id: 'm9', label: 'Minor 9th', symbol: 'm9', intervals: [0, 3, 7, 10, 14] },
  { id: '11', label: 'Dominant 11th', symbol: '11', intervals: [0, 4, 7, 10, 14, 17] },
  { id: 'm11', label: 'Minor 11th', symbol: 'm11', intervals: [0, 3, 7, 10, 14, 17] },
  { id: 'maj11', label: 'Major 11th', symbol: 'maj11', intervals: [0, 4, 7, 11, 14, 17] },
  { id: '13', label: 'Dominant 13th', symbol: '13', intervals: [0, 4, 7, 10, 14, 21] },
  { id: 'maj13', label: 'Major 13th', symbol: 'maj13', intervals: [0, 4, 7, 11, 14, 21] },
  { id: 'm13', label: 'Minor 13th', symbol: 'm13', intervals: [0, 3, 7, 10, 14, 21] },
];

const BY_ID = new Map(CHORDS.map((c) => [c.id, c]));
const MAJOR = CHORDS[0] as Chord;

/** The chord with this id; unknown ids give the major triad. */
export function getChord(id: string): Chord {
  return BY_ID.get(id) ?? MAJOR;
}

/** Whether `id` names a known chord quality. */
export function isChordId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * How a chord's notes are spread:
 * - close: stacked as tightly as the chord allows (root position);
 * - open: every second note from the bottom goes up an octave (C E G → C G E');
 * - drop2 / drop3: the second / third note from the top goes down an octave (jazz voicings);
 * - bass: close, plus the lowest note doubled an octave below;
 * - spread: open, plus the bass note.
 */
export type Voicing = 'close' | 'open' | 'drop2' | 'drop3' | 'bass' | 'spread';
/** Every voicing, for menus. */
export const VOICINGS: readonly Voicing[] = ['close', 'open', 'drop2', 'drop3', 'bass', 'spread'];

/** Folds keys into 0–127 by octaves, sorts them and drops duplicates. */
export function fitKeys(keys: readonly number[]): number[] {
  const out = new Set<number>();
  for (const raw of keys) {
    let k = Math.round(raw);
    while (k > 127) k -= 12;
    while (k < 0) k += 12;
    out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Inverts a chord: each positive step moves the lowest note up an octave (1 = first inversion),
 * each negative step moves the highest note down an octave. Returns sorted keys.
 */
export function invert(keys: readonly number[], inversion: number): number[] {
  const out = [...keys].sort((a, b) => a - b);
  if (out.length < 2) return out;
  for (let i = 0; i < inversion; i++) {
    out.push((out.shift() as number) + 12);
    out.sort((a, b) => a - b);
  }
  for (let i = 0; i > inversion; i--) {
    out.unshift((out.pop() as number) - 12);
    out.sort((a, b) => a - b);
  }
  return out;
}

/** Applies a voicing to sorted chord keys (see `Voicing`). */
export function voice(keys: readonly number[], voicing: Voicing): number[] {
  const k = [...keys].sort((a, b) => a - b);
  const n = k.length;
  let out: number[];
  switch (voicing) {
    case 'close':
      out = k;
      break;
    case 'open':
    case 'spread':
      out = k.map((key, i) => (i % 2 === 1 && n > 2 ? key + 12 : key));
      if (voicing === 'spread' && n > 0) out.push((k[0] as number) - 12);
      break;
    case 'drop2':
      out = n >= 3 ? k.map((key, i) => (i === n - 2 ? key - 12 : key)) : k;
      break;
    case 'drop3':
      out = n >= 4 ? k.map((key, i) => (i === n - 3 ? key - 12 : key)) : k;
      break;
    case 'bass':
      out = n > 0 ? [(k[0] as number) - 12, ...k] : k;
      break;
  }
  return out.sort((a, b) => a - b);
}

/** How to build a chord: its inversion and voicing. */
export interface ChordOptions {
  /** 0 = root position, 1 = first inversion, … (negative: notes from the top move down). */
  inversion?: number;
  voicing?: Voicing;
}

/** The keys of a chord on `root` (a MIDI key), folded into 0–127. */
export function chordNotes(root: number, chordId: string, opts: ChordOptions = {}): number[] {
  const base = getChord(chordId).intervals.map((i) => Math.round(root) + i);
  return fitKeys(voice(invert(base, opts.inversion ?? 0), opts.voicing ?? 'close'));
}

/**
 * A chord built from the scale by stacking thirds on `key` (snapped down to the scale): size 3 =
 * triad, 4 = seventh chord, 5 = ninth, … `C` in C major gives C E G; `D` gives D F A.
 */
export function diatonicChord(key: number, root: number, scaleId: string, size = 3, opts: ChordOptions = {}): number[] {
  const step = scaleStep(key, root, scaleId);
  // Pentatonic and other gapped scales still stack every other scale note.
  const keys: number[] = [];
  for (let i = 0; i < Math.max(1, Math.round(size)); i++) keys.push(keyAtStep(step + i * 2, root, scaleId));
  return fitKeys(voice(invert(keys, opts.inversion ?? 0), opts.voicing ?? 'close'));
}

/** The chord quality the scale gives on a degree (0-based), e.g. degree 1 of major → 'minor'. */
export function diatonicQuality(degree: number, root: number, scaleId: string, size = 3): string | null {
  const len = getScale(scaleId).intervals.length;
  const d = ((Math.round(degree) % len) + len) % len;
  const base = keyAtStep(d, root, scaleId) + 48;
  const found = detectChord(diatonicChord(base, root, scaleId, size));
  return found && found.root === pitchClass(base) ? found.chord.id : null;
}

/** What `detectChord` found: the root, the chord quality, the bass note and the name of the chord. */
export interface DetectedChord {
  /** Pitch class of the chord's root. */
  root: number;
  chord: Chord;
  /** Pitch class of the lowest note (differs from `root` for inversions). */
  bass: number;
  /** "Am7", "C/E". */
  name: string;
}

/**
 * Names the chord formed by `keys` (pitch classes only; octaves and doublings don't matter). Prefers
 * the reading whose root is the bass note. Returns null when no chord in `CHORDS` matches.
 */
export function detectChord(keys: readonly number[]): DetectedChord | null {
  if (keys.length === 0) return null;
  const pcs = new Set(keys.map(pitchClass));
  const bass = pitchClass(Math.min(...keys));
  let best: DetectedChord | null = null;
  let bestScore = -Infinity;
  for (const chord of CHORDS) {
    const shape = new Set(chord.intervals.map((i) => i % 12));
    if (shape.size !== pcs.size) continue;
    for (const root of pcs) {
      let match = true;
      for (const i of shape)
        if (!pcs.has((root + i) % 12)) {
          match = false;
          break;
        }
      if (!match) continue;
      // Root in the bass first, then simpler chords (earlier in CHORDS).
      const score = (root === bass ? 1000 : 0) - CHORDS.indexOf(chord);
      if (score > bestScore) {
        bestScore = score;
        const name = `${PITCH_NAMES[root]}${chord.symbol}${root === bass ? '' : `/${PITCH_NAMES[bass]}`}`;
        best = { root, chord, bass, name };
      }
    }
  }
  return best;
}

/** "C#m7" for a root pitch class and chord id. */
export function chordName(root: number, chordId: string): string {
  return `${PITCH_NAMES[pitchClass(root)]}${getChord(chordId).symbol}`;
}
