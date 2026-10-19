/**
 * The song key as harmony sees it: the seven notes chords are built from, and the chord on each degree. Core may not import
 * `@agstudio/sdk/notes`, so the few scales harmony needs are listed here (ids match the SDK's; anything else reads as the
 * major or minor scale it sounds closest to).
 */
import { mod12, QUALITIES, type ChordSymbol } from './chord';

/** A song key as harmony needs it: the tonic's pitch class (0 to 11) and a scale id. */
export interface KeyLike {
  /** Pitch class of the tonic. */
  root: number;
  /** A scale id (`transport.key.scale`). */
  scale: string;
}

/** Seven-note scales by SDK id. */
const HEPTATONIC: Readonly<Record<string, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor': [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'phrygian-dominant': [0, 1, 4, 5, 7, 8, 10],
  'harmonic-major': [0, 2, 4, 5, 7, 8, 11],
};

/** Scales that sound minor (the third is flat). */
const MINOR_LIKE = /minor|aeolian|dorian|phrygian|locrian|blues/i;

/** Whether the key sounds major or minor. */
export const keyMode = (scale: string): 'major' | 'minor' => (MINOR_LIKE.test(scale) && scale !== 'major-pentatonic' && scale !== 'major-blues' ? 'minor' : 'major');

/** The seven notes chords are built from in this key (a pentatonic or blues scale uses its major or minor parent). */
export function harmonicScale(scale: string): readonly number[] {
  return HEPTATONIC[scale] ?? (keyMode(scale) === 'minor' ? (HEPTATONIC.minor as readonly number[]) : (HEPTATONIC.major as readonly number[]));
}

/** The quality whose notes (as semitones above the root) these are, or null. */
function qualityFor(intervals: readonly number[]): string | null {
  const key = intervals.join(',');
  for (const q of QUALITIES) if (q.intervals.map((i) => i % 12).join(',') === key && q.intervals.length === intervals.length) return q.id;
  return null;
}

/**
 * The chord on a scale degree (0 = the first), stacking thirds from the key's scale: a triad, or with `sevenths` a seventh
 * chord. A stack that is not a known chord (some exotic scales) falls back to a plain major or minor triad on that note.
 */
export function diatonicChord(key: KeyLike, degree: number, sevenths = false): ChordSymbol {
  const scale = harmonicScale(key.scale);
  const at = (i: number) => (scale[((i % 7) + 7) % 7] as number) + 12 * Math.floor(i / 7);
  const d = ((degree % 7) + 7) % 7;
  const base = at(d);
  const stack = [0, at(d + 2) - base, at(d + 4) - base];
  if (sevenths) stack.push(at(d + 6) - base);
  const quality = qualityFor(stack);
  const root = mod12(key.root + base);
  if (quality) return { root, quality };
  return { root, quality: stack[1] === 3 ? 'min' : 'maj' };
}

/** The scale degree (0–6) whose note is this pitch class, or -1 when it is not in the key's seven notes. */
export function degreeOf(key: KeyLike, pc: number): number {
  const scale = harmonicScale(key.scale);
  const rel = mod12(pc - key.root);
  return scale.indexOf(rel);
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const;

/** Roman numeral of a chord in a key ("vi", "IV", "bVII", "V7"), by the degree of its root; '' when the root is outside the key. */
export function romanOf(key: KeyLike, c: ChordSymbol): string {
  const scale = harmonicScale(key.scale);
  const rel = mod12(c.root - key.root);
  let deg = scale.indexOf(rel);
  let acc = '';
  if (deg < 0) {
    // A note between two degrees: name it as a flat of the degree above (bVII), or a sharp of the one below for the 4th.
    const up = scale.findIndex((s) => s === mod12(rel + 1));
    if (up >= 0) {
      deg = up;
      acc = 'b';
    } else return '';
  }
  const minorish = ['min', 'dim', 'm7', 'mMaj7', 'm7b5', 'dim7', 'm6', 'madd9', 'm9'].includes(c.quality);
  const numeral = minorish ? (ROMAN[deg] as string).toLowerCase() : (ROMAN[deg] as string);
  const tail =
    c.quality === 'min' || c.quality === 'maj'
      ? ''
      : c.quality === 'dim'
        ? '°'
        : c.quality === 'm7b5'
          ? 'ø7'
          : c.quality === 'dim7'
            ? '°7'
            : c.quality.replace(/^m(?!aj)/, '').replace(/^Maj/, 'maj');
  return `${acc}${numeral}${tail}`;
}

/** Chords of the key's seven degrees (triads or sevenths). */
export const diatonicChords = (key: KeyLike, sevenths = false): ChordSymbol[] =>
  Array.from({ length: 7 }, (_, d) => diatonicChord(key, d, sevenths));

/** Pitch classes of the key's scale (what "in key" means for a note; pentatonic and blues use their own notes). */
export function scalePitchClasses(key: KeyLike): number[] {
  const own = SCALE_NOTES[key.scale];
  const scale = own ?? harmonicScale(key.scale);
  return scale.map((i) => mod12(key.root + i));
}

/** The scales with a shape other than a seven-note one that the piano roll offers. */
const SCALE_NOTES: Readonly<Record<string, readonly number[]>> = {
  'major-pentatonic': [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  'major-blues': [0, 2, 3, 4, 7, 9],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  hirajoshi: [0, 2, 3, 7, 8],
  'in-sen': [0, 1, 5, 7, 10],
  'double-harmonic': [0, 1, 4, 5, 7, 8, 11],
  'hungarian-minor': [0, 2, 3, 6, 7, 8, 11],
  ...HEPTATONIC,
};
