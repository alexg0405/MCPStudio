/**
 * Chord progressions: a palette of common ones written as Roman numerals (so they fit any key), a way to turn them into
 * chords in the song key, and "what comes next" suggestions ranked by function (home, away, tension). Pure, no DOM.
 */
import { mod12, sameChord, type ChordSymbol } from './chord';
import { degreeOf, diatonicChord, harmonicScale, keyMode, romanOf, type KeyLike } from './scale';

export type Mood =
  | 'happy'
  | 'uplifting'
  | 'sad'
  | 'emotional'
  | 'dark'
  | 'epic'
  | 'dreamy'
  | 'chill'
  | 'tense'
  | 'nostalgic'
  | 'dramatic'
  | 'smooth'
  | 'driving';

export const MOODS: readonly Mood[] = [
  'happy',
  'uplifting',
  'sad',
  'emotional',
  'dark',
  'epic',
  'dreamy',
  'chill',
  'tense',
  'nostalgic',
  'dramatic',
  'smooth',
  'driving',
];

export const GENRES = ['pop', 'rock', 'edm', 'house', 'trap', 'hiphop', 'lofi', 'rnb', 'jazz', 'blues', 'cinematic', 'flamenco'] as const;
export type Genre = (typeof GENRES)[number];

export interface Progression {
  id: string;
  name: string;
  /** The key it is written for (the key's own seven notes decide the chords: "VI" in a minor key is its sixth note). */
  mode: 'major' | 'minor';
  /** Roman numerals, one per slot. Upper case = major, lower case = minor; a suffix adds 7, maj7, °, ø7, sus4, add9… */
  chords: readonly string[];
  /** Bars each chord lasts (one number for all, or one per chord). Default 1. */
  bars?: number | readonly number[];
  moods: readonly Mood[];
  genres: readonly Genre[];
  /** One plain line: what it sounds like and where it is used. */
  note: string;
}

export const PROGRESSIONS: readonly Progression[] = [
  { id: 'pop-axis', name: 'I–V–vi–IV', mode: 'major', chords: ['I', 'V', 'vi', 'IV'], moods: ['happy', 'uplifting', 'emotional'], genres: ['pop', 'rock', 'edm'], note: 'The pop workhorse: bright, singable, hundreds of hits.' },
  { id: 'pop-minor-start', name: 'vi–IV–I–V', mode: 'major', chords: ['vi', 'IV', 'I', 'V'], moods: ['emotional', 'uplifting', 'nostalgic'], genres: ['pop', 'rock', 'edm'], note: 'The same four chords starting on the sad one: wistful, builds toward the chorus.' },
  { id: 'doo-wop', name: 'I–vi–IV–V', mode: 'major', chords: ['I', 'vi', 'IV', 'V'], moods: ['nostalgic', 'happy', 'smooth'], genres: ['pop', 'rock', 'rnb'], note: 'The 50s progression: warm and nostalgic.' },
  { id: 'rock-145', name: 'I–IV–V–IV', mode: 'major', chords: ['I', 'IV', 'V', 'IV'], moods: ['happy', 'driving'], genres: ['rock', 'blues', 'pop'], note: 'Three-chord rock and roll: simple, loud, bouncy.' },
  { id: 'canon', name: 'Canon: I–V–vi–iii–IV–I–IV–V', mode: 'major', chords: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], moods: ['epic', 'emotional', 'uplifting'], genres: ['pop', 'cinematic'], note: 'Pachelbel’s eight-chord loop: a slow, steady climb that feels inevitable.' },
  { id: 'royal-road', name: 'IV–V–iii–vi', mode: 'major', chords: ['IVmaj7', 'V7', 'iii7', 'vi'], moods: ['dreamy', 'emotional', 'uplifting'], genres: ['pop', 'edm'], note: 'The J-pop “royal road”: bittersweet and soaring.' },
  { id: 'ii-v-i', name: 'ii–V–I', mode: 'major', chords: ['ii7', 'V7', 'Imaj7', 'Imaj7'], moods: ['smooth', 'chill', 'nostalgic'], genres: ['jazz', 'lofi', 'rnb'], note: 'The jazz cadence: tension, release, home.' },
  { id: 'turnaround', name: 'Imaj7–vi7–ii7–V7', mode: 'major', chords: ['Imaj7', 'vi7', 'ii7', 'V7'], moods: ['smooth', 'chill', 'dreamy'], genres: ['jazz', 'lofi', 'rnb', 'hiphop'], note: 'A jazz turnaround: mellow, circles back on itself.' },
  { id: 'lofi-maj', name: 'Imaj7–iii7–vi7–IVmaj7', mode: 'major', chords: ['Imaj7', 'iii7', 'vi7', 'IVmaj7'], moods: ['chill', 'dreamy', 'nostalgic'], genres: ['lofi', 'hiphop', 'rnb'], note: 'Soft descending thirds: the lo-fi study-beats loop.' },
  { id: 'mixolydian', name: 'I–bVII–IV–I', mode: 'major', chords: ['I', 'bVII', 'IV', 'I'], moods: ['driving', 'uplifting', 'happy'], genres: ['rock', 'pop', 'edm'], note: 'A flat seventh gives it a rock edge: anthemic, open.' },
  { id: 'plagal-loop', name: 'I–IV–vi–V', mode: 'major', chords: ['I', 'IV', 'vi', 'V'], moods: ['happy', 'uplifting', 'dreamy'], genres: ['pop', 'edm', 'house'], note: 'Rises and keeps going: a good festival drop loop.' },
  { id: 'house-stabs', name: 'ii7–V7–Imaj7–vi7', mode: 'major', chords: ['ii7', 'V7', 'Imaj7', 'vi7'], bars: 1, moods: ['smooth', 'uplifting', 'chill'], genres: ['house', 'jazz', 'rnb'], note: 'Jazzy seventh chords for stabs and pads in house and R&B.' },
  { id: 'blues-12', name: '12-bar blues', mode: 'major', chords: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], moods: ['driving', 'happy', 'tense'], genres: ['blues', 'rock', 'jazz'], note: 'The twelve-bar form: four bars home, two away, back, then the turnaround.' },
  { id: 'minor-epic', name: 'i–VI–III–VII', mode: 'minor', chords: ['i', 'VI', 'III', 'VII'], moods: ['epic', 'dramatic', 'emotional'], genres: ['edm', 'pop', 'cinematic', 'trap'], note: 'The big minor loop: emotional and cinematic, a staple of dance and pop.' },
  { id: 'minor-dark', name: 'i–VII–VI–VII', mode: 'minor', chords: ['i', 'VII', 'VI', 'VII'], moods: ['dark', 'driving', 'tense'], genres: ['rock', 'edm', 'trap', 'hiphop'], note: 'Rocking between the flat sixth and seventh: dark and relentless.' },
  { id: 'minor-iv', name: 'i–iv–VII–III', mode: 'minor', chords: ['i', 'iv', 'VII', 'III'], moods: ['sad', 'emotional', 'dramatic'], genres: ['pop', 'rock', 'rnb'], note: 'A sad loop that never quite settles.' },
  { id: 'minor-dominant', name: 'i–VI–iv–V', mode: 'minor', chords: ['i', 'VI', 'iv', 'V'], moods: ['dramatic', 'tense', 'epic'], genres: ['cinematic', 'pop', 'edm'], note: 'A major V pulls hard back to i: dramatic, film-score energy.' },
  { id: 'andalusian', name: 'Andalusian: i–VII–VI–V', mode: 'minor', chords: ['i', 'VII', 'VI', 'V'], moods: ['dramatic', 'dark', 'tense'], genres: ['flamenco', 'cinematic', 'rock'], note: 'A falling line of four chords: flamenco, tension, fate.' },
  { id: 'minor-ii-v-i', name: 'iiø7–V7–i7', mode: 'minor', chords: ['iiø7', 'V7', 'i7', 'i7'], moods: ['smooth', 'sad', 'tense'], genres: ['jazz', 'lofi', 'rnb'], note: 'The minor jazz cadence: shadowy and smooth.' },
  { id: 'trap-two', name: 'Trap loop: i–VI', mode: 'minor', chords: ['i', 'VI'], bars: 2, moods: ['dark', 'sad', 'chill'], genres: ['trap', 'hiphop'], note: 'Two chords, two bars each: the minimal trap loop that leaves room for the 808.' },
  { id: 'trap-three', name: 'Trap loop: i–VI–VII', mode: 'minor', chords: ['i', 'VI', 'VII'], bars: [2, 1, 1], moods: ['dark', 'driving', 'epic'], genres: ['trap', 'hiphop', 'edm'], note: 'Dark and heavy, with a rising lift at the end of the loop.' },
  { id: 'trap-phrygian', name: 'Trap loop: i–bII', mode: 'minor', chords: ['i', 'bII'], bars: 2, moods: ['dark', 'tense', 'dramatic'], genres: ['trap', 'cinematic'], note: 'A half step up: menacing, used in drill and dark trap.' },
  { id: 'trap-iv', name: 'Trap loop: i–iv–i–v', mode: 'minor', chords: ['i', 'iv', 'i', 'v'], moods: ['sad', 'chill', 'dark'], genres: ['trap', 'hiphop', 'rnb'], note: 'Slow minor movement: moody and laid back.' },
  { id: 'lofi-min', name: 'i7–iv7–VII7–IIImaj7', mode: 'minor', chords: ['i7', 'iv7', 'VII7', 'IIImaj7'], moods: ['chill', 'sad', 'nostalgic'], genres: ['lofi', 'hiphop', 'rnb'], note: 'Seventh chords all the way: late-night lo-fi.' },
  { id: 'rnb-minor', name: 'i7–VImaj7–iv7–V7', mode: 'minor', chords: ['i7', 'VImaj7', 'iv7', 'V7'], moods: ['smooth', 'emotional', 'dreamy'], genres: ['rnb', 'lofi', 'jazz'], note: 'Velvet seventh chords with a dominant to turn around on.' },
];

const BY_ID = new Map(PROGRESSIONS.map((progression) => [progression.id, progression]));

export const getProgression = (id: string): Progression | undefined => BY_ID.get(id);

/** Progressions that match: the key's mode, a mood and/or a genre, and words in the name or note. Best matches first. */
export function findProgressions(filter: { mode?: 'major' | 'minor'; mood?: string; genre?: string; text?: string } = {}): Progression[] {
  const text = filter.text?.trim().toLowerCase();
  return PROGRESSIONS.filter(
    (progression) =>
      (!filter.mode || progression.mode === filter.mode) &&
      (!filter.mood || (progression.moods as readonly string[]).includes(filter.mood.toLowerCase())) &&
      (!filter.genre || (progression.genres as readonly string[]).includes(filter.genre.toLowerCase())) &&
      (!text ||
        `${progression.name} ${progression.note} ${progression.moods.join(' ')} ${progression.genres.join(' ')} ${progression.id}`
          .toLowerCase()
          .includes(text)),
  );
}

/** A progression by id, or by (part of) its name. */
export function lookupProgression(ref: string): Progression | undefined {
  const wanted = ref.trim().toLowerCase();
  return (
    BY_ID.get(wanted) ??
    PROGRESSIONS.find((progression) => progression.name.toLowerCase() === wanted) ??
    PROGRESSIONS.find((progression) => progression.name.toLowerCase().includes(wanted))
  );
}

const NUMERALS: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

/** A Roman-numeral chord in a key: its root and quality, or null when the text is not one. */
export function parseRoman(text: string, key: KeyLike): ChordSymbol | null {
  const m = /^([b♭#♯]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(.*)$/.exec(text.trim());
  if (!m) return null;
  const upper = (m[2] as string) === (m[2] as string).toUpperCase();
  const degree = NUMERALS[(m[2] as string).toLowerCase()] as number;
  const scale = harmonicScale(key.scale);
  const shift = m[1] === 'b' || m[1] === '♭' ? -1 : m[1] === '#' || m[1] === '♯' ? 1 : 0;
  const root = mod12(key.root + (scale[degree] as number) + shift);
  const tail = (m[3] as string).replace(/\(|\)/g, '');
  let quality: string;
  switch (tail) {
    case '':
      quality = upper ? 'maj' : 'min';
      break;
    case '7':
      quality = upper ? '7' : 'm7';
      break;
    case 'maj7':
    case 'M7':
    case 'Δ7':
    case 'Δ':
      quality = upper ? 'maj7' : 'mMaj7';
      break;
    case '°':
    case 'dim':
      quality = 'dim';
      break;
    case '°7':
    case 'dim7':
      quality = 'dim7';
      break;
    case 'ø':
    case 'ø7':
    case 'm7b5':
      quality = 'm7b5';
      break;
    case '9':
      quality = upper ? '9' : 'm9';
      break;
    case 'maj9':
      quality = 'maj9';
      break;
    case 'sus4':
    case 'sus':
      quality = 'sus4';
      break;
    case 'sus2':
      quality = 'sus2';
      break;
    case 'add9':
      quality = upper ? 'add9' : 'madd9';
      break;
    case '6':
      quality = upper ? '6' : 'm6';
      break;
    case '5':
      quality = '5';
      break;
    case '7sus4':
      quality = '7sus4';
      break;
    default:
      return null;
  }
  return { root, quality };
}

/** A progression's chords in a key, each with its length in bars. */
export function progressionChords(prog: Progression, key: KeyLike): { chord: ChordSymbol; bars: number }[] {
  const out: { chord: ChordSymbol; bars: number }[] = [];
  prog.chords.forEach((r, i) => {
    const chord = parseRoman(r, key);
    if (!chord) return;
    const bars = typeof prog.bars === 'number' ? prog.bars : (prog.bars?.[i] ?? 1);
    out.push({ chord, bars });
  });
  return out;
}

/** The sevenths version of a triad in a key: the seventh chord the scale makes on that note (or the nearest plain one). */
export function withSeventh(chord: ChordSymbol, key: KeyLike): ChordSymbol {
  if (chord.quality !== 'maj' && chord.quality !== 'min' && chord.quality !== 'dim') return chord;
  const d = degreeOf(key, chord.root);
  if (d >= 0) {
    const seventh = diatonicChord(key, d, true);
    // Keep the written triad quality when the scale's own third differs (a borrowed chord).
    if (seventh.root === chord.root && (chord.quality === 'maj') === (seventh.quality === 'maj7' || seventh.quality === '7')) return seventh;
    if (seventh.root === chord.root && chord.quality === 'dim') return seventh;
  }
  return { root: chord.root, quality: chord.quality === 'maj' ? 'maj7' : chord.quality === 'min' ? 'm7' : 'dim7' };
}

export interface BuiltChord {
  /** Song tick the chord starts at. */
  tick: number;
  length: number;
  chord: ChordSymbol;
}

/**
 * A progression laid out in time from `startTick`, repeated to fill `bars` bars (default one pass). `sevenths` turns the
 * plain triads into the key's seventh chords. The last chord is cut at the end when the bars are not a whole number of passes.
 */
export function layoutProgression(
  prog: Progression,
  key: KeyLike,
  opts: { startTick: number; bar: number; bars?: number; sevenths?: boolean },
): BuiltChord[] {
  const slots = progressionChords(prog, key).map((s) => ({
    chord: opts.sevenths ? withSeventh(s.chord, key) : s.chord,
    bars: s.bars,
  }));
  if (slots.length === 0) return [];
  const pass = slots.reduce((a, s) => a + s.bars, 0);
  const total = Math.max(1, Math.round(opts.bars ?? pass));
  const out: BuiltChord[] = [];
  let bar = 0;
  while (bar < total) {
    for (const s of slots) {
      if (bar >= total) break;
      const bars = Math.min(s.bars, total - bar);
      out.push({ tick: opts.startTick + Math.round(bar * opts.bar), length: Math.round(bars * opts.bar), chord: s.chord });
      bar += s.bars;
    }
  }
  // Neighbours that are the same chord are one long chord.
  const merged: BuiltChord[] = [];
  for (const b of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.tick + prev.length === b.tick && sameChord(prev.chord, b.chord)) prev.length += b.length;
    else merged.push({ ...b });
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// What comes next

export type ChordFunction = 'tonic' | 'subdominant' | 'dominant' | 'other';

/** The role of a degree: tonic (home: I, iii, vi), subdominant (away: ii, IV), dominant (tension: V, vii°). */
export function functionOfDegree(degree: number): ChordFunction {
  switch (((degree % 7) + 7) % 7) {
    case 0:
    case 2:
    case 5:
      return 'tonic';
    case 1:
    case 3:
      return 'subdominant';
    default:
      return 'dominant';
  }
}

/** How much a chord on degree `to` likes to follow one on degree `from` (0–4), in a major key and in a minor key. */
const FOLLOW: Record<'major' | 'minor', number[][]> = {
  major: [
    //   I    ii   iii  IV   V    vi   vii
    [0.2, 2.0, 1.2, 3.0, 3.0, 2.5, 0.3], // I
    [0.5, 0.1, 0.5, 1.0, 4.0, 0.8, 1.0], // ii
    [0.3, 1.5, 0.1, 2.5, 1.0, 3.0, 0.2], // iii
    [3.0, 2.0, 0.4, 0.1, 3.5, 1.5, 0.6], // IV
    [4.0, 0.4, 1.0, 1.5, 0.2, 3.0, 0.3], // V
    [1.5, 2.5, 1.0, 3.5, 2.5, 0.1, 0.3], // vi
    [3.5, 0.2, 1.0, 0.3, 0.3, 0.8, 0.1], // vii°
  ],
  minor: [
    //   i    ii°  III  iv   v    VI   VII
    [0.2, 0.6, 2.0, 2.5, 2.0, 3.0, 3.0], // i
    [1.0, 0.1, 0.5, 0.6, 4.0, 0.8, 1.0], // ii°
    [2.0, 0.5, 0.1, 2.0, 1.0, 3.0, 3.0], // III
    [2.5, 1.0, 0.8, 0.1, 3.0, 1.5, 3.0], // iv
    [4.0, 0.3, 1.0, 1.5, 0.2, 2.5, 0.5], // v
    [1.5, 1.0, 2.0, 2.5, 2.5, 0.1, 3.0], // VI
    [3.5, 0.3, 3.0, 0.8, 0.8, 1.5, 0.1], // VII
  ],
};

/** Chords to open a progression with, by how well they set the key. */
const OPENERS: Record<'major' | 'minor', number[]> = {
  major: [4.0, 0.8, 0.5, 2.2, 1.2, 2.6, 0.1],
  minor: [4.0, 0.2, 1.8, 1.6, 0.6, 2.4, 1.6],
};

export interface NextChord {
  chord: ChordSymbol;
  /** Roman numeral in the key ("V", "vi"). */
  roman: string;
  function: ChordFunction;
  /** 0–1, 1 = the strongest choice. */
  score: number;
  /** One plain line: why it follows. */
  reason: string;
}

const FUNCTION_REASON: Record<string, string> = {
  'dominant>tonic': 'resolves the tension: back home',
  'subdominant>dominant': 'builds tension toward home',
  'tonic>subdominant': 'moves away from home',
  'tonic>dominant': 'jumps to tension',
  'tonic>tonic': 'stays close to home',
  'subdominant>tonic': 'settles back home',
  'subdominant>subdominant': 'stays in the away area',
  'dominant>subdominant': 'steps back from the tension',
  'dominant>dominant': 'keeps the tension up',
};

/**
 * Chords that could follow `previous`, ranked by how often that move works in the key (home → away → tension → home).
 * Without a previous chord it suggests ways to open. `sevenths` offers seventh chords. A previous chord outside the key
 * is treated as a visitor that resolves like a dominant, and the key's chords are ranked by how near they are in the circle
 * of fifths.
 */
export function suggestNext(
  key: KeyLike,
  previous: ChordSymbol | null,
  opts: { sevenths?: boolean; limit?: number; before?: ChordSymbol | null } = {},
): NextChord[] {
  const mode = keyMode(key.scale);
  const table = FOLLOW[mode];
  const from = previous ? degreeOf(key, previous.root) : -1;
  const weights: number[] = previous
    ? from >= 0
      ? (table[from] as number[]).slice()
      : Array.from({ length: 7 }, (_, d) => {
          // Outside the key: the chord a fifth below the visitor's root is where it wants to go.
          const target = mod12(previous.root - 7);
          return degreeOf(key, target) === d ? 4 : degreeOf(key, mod12(previous.root + 1)) === d ? 2.5 : 1;
        })
    : OPENERS[mode].slice();
  // Do not bounce straight back to the chord before the last one.
  if (opts.before) {
    const b = degreeOf(key, opts.before.root);
    if (b >= 0) weights[b] = (weights[b] as number) * 0.6;
  }
  const max = Math.max(...weights);
  const out: NextChord[] = weights.map((w, d) => {
    const chord = diatonicChord(key, d, opts.sevenths === true);
    const fn = functionOfDegree(d);
    const pair = from >= 0 ? `${functionOfDegree(from)}>${fn}` : '';
    let reason = previous ? (FUNCTION_REASON[pair] ?? 'fits the key') : d === 0 ? 'sets the key: starts on home' : fn === 'tonic' ? 'an easy start, close to home' : fn === 'subdominant' ? 'starts away from home, leaves the key open' : 'starts on tension';
    if (from === 4 && d === 5) reason = 'deceptive: the tension goes to vi instead of home';
    if (from === 4 && d === 0 && mode === 'major') reason = 'resolves the tension: back home';
    return { chord, roman: romanOf(key, chord), function: fn, score: Math.round((w / max) * 100) / 100, reason };
  });
  // Two borrowed chords: the flat seventh in major, the major V in minor.
  const borrowed: ChordSymbol[] = mode === 'major' ? [{ root: mod12(key.root + 10), quality: opts.sevenths ? '7' : 'maj' }, { root: mod12(key.root + 5), quality: opts.sevenths ? 'm7' : 'min' }] : [{ root: mod12(key.root + 7), quality: opts.sevenths ? '7' : 'maj' }];
  for (const [i, chord] of borrowed.entries()) {
    const fn: ChordFunction = 'other';
    const score = previous && from >= 0 ? (from === 0 || from === 3 ? 0.35 - i * 0.1 : 0.15) : 0.1;
    out.push({ chord, roman: romanOf(key, chord), function: fn, score, reason: mode === 'major' ? (i === 0 ? 'borrowed from the key next door: a rock edge' : 'borrowed minor four: bittersweet') : 'the major V from the harmonic minor: pulls hard back to home' });
  }
  out.sort((a, b) => b.score - a.score);
  // Not the chord just played again.
  const filtered = previous ? out.filter((n) => !sameChord(n.chord, previous)) : out;
  return filtered.slice(0, opts.limit ?? 6);
}
