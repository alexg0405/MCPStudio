/**
 * Chord symbols: what the chord track holds. A symbol is a root (pitch class), a quality ("m7", "sus4", "add9"…) and an
 * optional slash bass ("F/C"). `parseChord` reads what people type ("Am7", "F/C", "Bbmaj7", "C°7"), `formatChord` writes
 * it back, and `chordPitchClasses` says which notes it contains. Pure, no DOM. (The piano roll's own chord stamp lives in
 * `@agstudio/sdk/notes`; core may not import it, so this module has its own small table.)
 */

export interface QualityDef {
  /** Stable id stored in projects. */
  readonly id: string;
  /** Written after the root: "m7" → Am7. */
  readonly suffix: string;
  /** Plain name for menus. */
  readonly label: string;
  /** Semitones above the root (may exceed 12 for 9ths: they are the same pitch class one octave up). */
  readonly intervals: readonly number[];
  /** Other spellings `parseChord` accepts. */
  readonly aliases?: readonly string[];
  /** Left out of chord detection: it has the same notes as another chord's inversion (C6 = Am7/C). */
  readonly noDetect?: boolean;
}

/**
 * Every chord quality the app knows (major, minor, sevenths, suspended, extended and so on), with its notes as
 * semitones above the root and the spellings that are accepted when typing.
 */
export const QUALITIES: readonly QualityDef[] = [
  { id: 'maj', suffix: '', label: 'Major', intervals: [0, 4, 7], aliases: ['M', 'maj', 'major'] },
  { id: 'min', suffix: 'm', label: 'Minor', intervals: [0, 3, 7], aliases: ['min', 'mi', '-', 'minor'] },
  { id: 'dim', suffix: 'dim', label: 'Diminished', intervals: [0, 3, 6], aliases: ['°', 'o', 'mb5', 'm♭5'] },
  { id: 'aug', suffix: 'aug', label: 'Augmented', intervals: [0, 4, 8], aliases: ['+', '+5'] },
  { id: 'sus2', suffix: 'sus2', label: 'Suspended 2nd', intervals: [0, 2, 7] },
  { id: 'sus4', suffix: 'sus4', label: 'Suspended 4th', intervals: [0, 5, 7], aliases: ['sus'] },
  { id: '5', suffix: '5', label: 'Power chord', intervals: [0, 7], aliases: ['power'] },
  { id: '6', suffix: '6', label: 'Major 6th', intervals: [0, 4, 7, 9], aliases: ['M6', 'maj6'], noDetect: true },
  { id: 'm6', suffix: 'm6', label: 'Minor 6th', intervals: [0, 3, 7, 9], aliases: ['min6', '-6'], noDetect: true },
  { id: '7', suffix: '7', label: 'Dominant 7th', intervals: [0, 4, 7, 10], aliases: ['dom7'] },
  {
    id: 'maj7',
    suffix: 'maj7',
    label: 'Major 7th',
    intervals: [0, 4, 7, 11],
    aliases: ['M7', 'ma7', 'Δ7', 'Δ', 'maj7', 'major7'],
  },
  { id: 'm7', suffix: 'm7', label: 'Minor 7th', intervals: [0, 3, 7, 10], aliases: ['min7', 'mi7', '-7', 'minor7'] },
  {
    id: 'mMaj7',
    suffix: 'm(maj7)',
    label: 'Minor major 7th',
    intervals: [0, 3, 7, 11],
    aliases: ['mmaj7', 'mM7', 'min(maj7)', 'minmaj7', 'm△7', '-Δ7', 'mΔ7'],
  },
  {
    id: 'm7b5',
    suffix: 'm7b5',
    label: 'Half-diminished 7th',
    intervals: [0, 3, 6, 10],
    aliases: ['ø', 'ø7', 'm7♭5', 'min7b5', '-7b5', 'm7(b5)', 'hdim7'],
  },
  { id: 'dim7', suffix: 'dim7', label: 'Diminished 7th', intervals: [0, 3, 6, 9], aliases: ['°7', 'o7'] },
  { id: '7sus4', suffix: '7sus4', label: '7th suspended 4th', intervals: [0, 5, 7, 10], aliases: ['7sus'] },
  { id: 'add9', suffix: 'add9', label: 'Add 9', intervals: [0, 4, 7, 14], aliases: ['add2', '2'] },
  { id: 'madd9', suffix: 'madd9', label: 'Minor add 9', intervals: [0, 3, 7, 14], aliases: ['minadd9', 'm(add9)', '-add9'] },
  { id: '9', suffix: '9', label: 'Dominant 9th', intervals: [0, 4, 7, 10, 14], aliases: ['dom9'] },
  { id: 'maj9', suffix: 'maj9', label: 'Major 9th', intervals: [0, 4, 7, 11, 14], aliases: ['M9', 'Δ9'] },
  { id: 'm9', suffix: 'm9', label: 'Minor 9th', intervals: [0, 3, 7, 10, 14], aliases: ['min9', '-9'] },
];

/** The stable id of a chord quality (an `id` from `QUALITIES`), as stored in projects. */
export type QualityId = string;

const BY_ID = new Map(QUALITIES.map((quality) => [quality.id, quality]));

/** True when `id` is the id of a known chord quality; used to check loose input (files, the AI). */
export const isQualityId = (id: unknown): id is QualityId => typeof id === 'string' && BY_ID.has(id);

/** The quality with this id (unknown ids read as major). */
export const qualityOf = (id: string): QualityDef => BY_ID.get(id) ?? (QUALITIES[0] as QualityDef);

/** A chord: pitch-class root 0–11, a quality id and an optional pitch-class bass for slash chords. */
export interface ChordSymbol {
  root: number;
  quality: QualityId;
  bass?: number;
}

/** A number folded onto a pitch class 0 to 11 (rounded first, so it works for negative and fractional keys). */
export const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Pitch-class name; flats for keys that are written with flats (F, Bb, Eb, Ab, Db, Gb major and their relatives). */
export const pitchName = (pc: number, flats = false): string => (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)] as string;

// Tonics whose key signature has flats (major: F Bb Eb Ab Db Gb; minor: D G C F Bb Eb).
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

/** Whether chords of this key read better with flats ("Bb" rather than "A#"). */
export const keyUsesFlats = (root: number, mode: 'major' | 'minor'): boolean =>
  (mode === 'major' ? FLAT_MAJOR : FLAT_MINOR).has(mod12(root));

/** The notes of a chord as pitch classes: root first, then the other notes in order of their interval (no duplicates). */
export function chordPitchClasses(c: ChordSymbol): number[] {
  const out: number[] = [];
  for (const i of qualityOf(c.quality).intervals) {
    const pc = mod12(c.root + i);
    if (!out.includes(pc)) out.push(pc);
  }
  return out;
}

/** The chord's name: "Am7", "F/C", "Bbmaj7". */
export function formatChord(c: ChordSymbol, flats = false): string {
  const q = qualityOf(c.quality);
  const bass = c.bass !== undefined && mod12(c.bass) !== mod12(c.root) ? `/${pitchName(c.bass, flats)}` : '';
  return `${pitchName(c.root, flats)}${q.suffix}${bass}`;
}

/** Same chord (root, quality and bass; a bass equal to the root counts as none). */
export function sameChord(a: ChordSymbol | null | undefined, b: ChordSymbol | null | undefined): boolean {
  if (!a || !b) return a === b;
  const ba = a.bass !== undefined && mod12(a.bass) !== mod12(a.root) ? mod12(a.bass) : -1;
  const bb = b.bass !== undefined && mod12(b.bass) !== mod12(b.root) ? mod12(b.bass) : -1;
  return mod12(a.root) === mod12(b.root) && a.quality === b.quality && ba === bb;
}

const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Every spelling of a quality as typed (case matters: "M7" is major, "m7" minor). */
const EXACT = new Map<string, string>();
/** Spellings matched without regard to case ("MAJ7", "Dim"), left out where two qualities share one in lower case. */
const LOOSE = new Map<string, string>();
for (const quality of QUALITIES) {
  for (const text of [quality.suffix, ...(quality.aliases ?? [])]) if (!EXACT.has(text)) EXACT.set(text, quality.id);
}
{
  const seen = new Map<string, string | null>();
  for (const [text, id] of EXACT) {
    const k = text.toLowerCase();
    seen.set(k, seen.has(k) && seen.get(k) !== id ? null : id);
  }
  for (const [k, id] of seen) if (id) LOOSE.set(k, id);
}

function qualityFrom(text: string): string | null {
  const t = text.trim();
  const exact = EXACT.get(t);
  if (exact !== undefined) return exact;
  // Brackets are decoration ("C7(b5)" is not supported, "Cm(maj7)" and "Cadd(9)" are): try without them too.
  const bare = t.replace(/[()]/g, '');
  return EXACT.get(bare) ?? LOOSE.get(bare.toLowerCase()) ?? null;
}

/** A pitch-class name at the start of `text` ("Bb", "F#", "Eb"…): its value and the rest, or null. */
function readNote(text: string): { pc: number; rest: string } | null {
  const m = /^([A-Ga-g])([#♯b♭]?)/.exec(text);
  if (!m) return null;
  let pc = LETTERS[(m[1] as string).toLowerCase()] as number;
  const acc = m[2] as string;
  if (acc === '#' || acc === '♯') pc += 1;
  else if (acc === 'b' || acc === '♭') {
    // "Bb" is B flat, but "Bbb" is not worth supporting; "Cb"/"B" handled by mod 12. A lone "b" after a letter is a flat.
    pc -= 1;
  }
  return { pc: mod12(pc), rest: text.slice(m[0].length) };
}

/**
 * Reads a chord name. Accepts "C", "Am", "Am7", "F/C", "Bbmaj7", "C#m7b5", "Gsus4", "Dadd9", "C°7", "Cø". Returns null for
 * anything else (an empty string, a word that is not a chord).
 */
export function parseChord(text: string): ChordSymbol | null {
  const t = text.trim();
  if (!t) return null;
  const head = readNote(t);
  if (!head) return null;
  let body = head.rest;
  let bass: number | undefined;
  const slash = body.lastIndexOf('/');
  if (slash >= 0) {
    const after = body.slice(slash + 1);
    const b = readNote(after);
    // "6/9" is a chord, not a slash chord (it has no note name after the slash).
    if (b && b.rest === '') {
      bass = b.pc;
      body = body.slice(0, slash);
    } else if (!/^\d/.test(after)) return null;
  }
  const quality = qualityFrom(body);
  if (quality === null) return null;
  const out: ChordSymbol = { root: head.pc, quality };
  if (bass !== undefined && bass !== head.pc) out.bass = bass;
  return out;
}

/**
 * Reads a progression written in one line: chords separated by "|", spaces, commas or dashes between names ("Am7 | F | C
 * | G", "Am F C G"). Names that are not chords are reported in `bad`. A "." or "-" alone means "the chord holds".
 */
export function parseChordLine(text: string): { chords: (ChordSymbol | null)[]; bad: string[] } {
  const chords: (ChordSymbol | null)[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[|,;\n]+|\s+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === '.' || tok === '-' || tok === '–' || tok === '%') {
      chords.push(null);
      continue;
    }
    const c = parseChord(tok);
    if (c) chords.push(c);
    else bad.push(tok);
  }
  return { chords, bad };
}

/** The chord with its notes shifted by `semitones` (transposing a chord track). */
export function transposeChord(c: ChordSymbol, semitones: number): ChordSymbol {
  const out: ChordSymbol = { root: mod12(c.root + semitones), quality: c.quality };
  if (c.bass !== undefined) out.bass = mod12(c.bass + semitones);
  return out;
}
