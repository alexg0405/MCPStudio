/**
 * Chord: turns every note into a chord. The chord can be a named shape built on the note (a minor 7th on C), the note plus a
 * few intervals you choose, a chord stacked in the song key on the note's scale degree, or the chord the chord track has at that
 * moment. Inversion and spread then lay the notes out.
 */
import { p } from '@agstudio/sdk/params';
import { chordPitchClasses, mod12, QUALITIES, qualityOf, type ChordSymbol } from '../../harmony/chord';
import { derivedNote, isPlayableKey, MAX_KEY, MIN_KEY } from '../note-utils';
import { stepInScale } from '../scale-tools';
import type { FxContext, FxNote, FxRun, MidiFxDef } from '../types';

const SOURCES = ['shape', 'intervals', 'scale', 'chordTrack'];
const SOURCE_LABELS = {
  shape: 'A chord shape',
  intervals: 'Notes I add',
  scale: 'Stacked in the song key',
  chordTrack: 'The chord track',
};
const SPREADS = ['close', 'open', 'drop2', 'spread'];
const SPREAD_LABELS = { close: 'Close', open: 'Open', drop2: 'Drop 2', spread: 'Spread (with a low root)' };
const SHAPE_IDS = QUALITIES.map((quality) => quality.id);
const SHAPE_LABELS: Record<string, string> = Object.fromEntries(QUALITIES.map((quality) => [quality.id, quality.label]));
/** An octave in semitones. */
const OCTAVE = 12;
/** The chord track's chord is voiced with its root within this many semitones of the note that was played. */
const ROOT_SEARCH_BELOW = 6;
/** The scale steps a chord stacked in the key takes above the played note: thirds, so 2, 4, 6, 8. */
const THIRD_IN_STEPS = 2;

/** The keys of the chord built from `note`, lowest first (before inversion and spread), or null to leave the note alone. */
function chordKeys(note: FxNote, run: FxRun): number[] | null {
  const context = run.context;
  switch (String(run.values.source)) {
    case 'intervals':
      return addedIntervals(note.key, run, note.start);
    case 'scale':
      return stackedInKey(note.key, Math.round(run.param('size', note.start)), context);
    case 'chordTrack': {
      const chord = context.chordAt(note.start);
      return chord ? chordTrackKeys(note.key, chord) : null;
    }
    default:
      return qualityOf(String(run.values.shape)).intervals.map((interval) => note.key + interval);
  }
}

/** The note and up to three intervals (in semitones from the note; 0 means "not used"). */
function addedIntervals(key: number, run: FxRun, at: number): number[] {
  const keys = [key];
  for (const name of ['add1', 'add2', 'add3']) {
    const interval = Math.round(run.param(name, at));
    if (interval !== 0) keys.push(key + interval);
  }
  return keys;
}

/** `size` notes stacked in thirds of the song key, starting on the played note's degree (the note itself without a key: a major chord). */
function stackedInKey(key: number, size: number, context: FxContext): number[] {
  if (!context.key) return [key, key + 4, key + 7, key + 11, key + 14].slice(0, size);
  const keys: number[] = [];
  for (let third = 0; third < size; third++) {
    const stacked = stepInScale(key, THIRD_IN_STEPS * third, context.key);
    if (stacked !== null) keys.push(stacked);
  }
  return keys;
}

/** The chord of the chord track voiced upward from its root nearest the played key (a slash chord's bass goes underneath). */
function chordTrackKeys(played: number, chord: ChordSymbol): number[] {
  const classes = chordPitchClasses(chord);
  const lowest = played - ROOT_SEARCH_BELOW + mod12(chord.root - (played - ROOT_SEARCH_BELOW));
  const keys = [lowest];
  for (let i = 1; i < classes.length; i++) {
    const below = keys[i - 1] as number;
    keys.push(below + (mod12((classes[i] as number) - below) || OCTAVE));
  }
  if (chord.bass !== undefined && mod12(chord.bass) !== mod12(chord.root)) {
    const gap = mod12(lowest - chord.bass) || OCTAVE;
    keys.unshift(lowest - gap);
  }
  return keys;
}

/** Moves the lowest note up an octave `inversion` times (the chord's first, second… inversion). */
function invert(keys: readonly number[], inversion: number): number[] {
  const result = [...keys].sort((a, b) => a - b);
  for (let i = 0; i < inversion && result.length > 1; i++) {
    const lowest = result.shift() as number;
    result.push(lowest + OCTAVE);
  }
  return result;
}

/** Spreads a chord: close leaves it, open lifts every second note an octave, drop 2 lowers the second from the top, spread adds a low root. */
function spread(keys: readonly number[], how: string): number[] {
  const sorted = [...keys].sort((a, b) => a - b);
  if (how === 'close' || sorted.length < 2) return sorted;
  if (how === 'drop2') {
    return sorted.map((key, i) => (i === sorted.length - 2 ? key - OCTAVE : key)).sort((a, b) => a - b);
  }
  const open = sorted.map((key, i) => (i % 2 === 1 ? key + OCTAVE : key)).sort((a, b) => a - b);
  return how === 'spread' ? [(sorted[0] as number) - OCTAVE, ...open] : open;
}

/** Chord: see the file comment. */
export const chord: MidiFxDef = {
  id: 'chord',
  name: 'Chord',
  short: 'CHD',
  description: 'Turns every note into a chord: a named shape, notes you add, a chord in the song key, or the chord from the chord track.',
  params: {
    source: p.enum(SOURCES, 'shape', { group: 'Chord', label: 'Chord from', labels: SOURCE_LABELS, hint: 'Where the chord’s notes come from' }),
    shape: p.enum(SHAPE_IDS, 'maj', { group: 'Chord', label: 'Shape', labels: SHAPE_LABELS, hint: 'A chord shape built on each note you play' }),
    size: p.int(2, 5, 3, { group: 'Chord', label: 'Notes', hint: 'Stacked in the song key: how many notes the chord has (3 = triad, 4 = seventh)' }),
    add1: p.int(-24, 24, 7, { group: 'Notes I add', label: 'Add 1', unit: 'st', hint: 'Notes I add: an interval above (or below) each note in semitones; 0 means none' }),
    add2: p.int(-24, 24, 0, { group: 'Notes I add', label: 'Add 2', unit: 'st', hint: 'Notes I add: another interval in semitones; 0 means none' }),
    add3: p.int(-24, 24, 0, { group: 'Notes I add', label: 'Add 3', unit: 'st', hint: 'Notes I add: another interval in semitones; 0 means none' }),
    inversion: p.int(0, 4, 0, { group: 'Layout', label: 'Inversion', hint: 'Moves the lowest note up an octave this many times' }),
    spread: p.enum(SPREADS, 'close', { group: 'Layout', label: 'Spread', labels: SPREAD_LABELS, hint: 'How the notes of the chord are laid out' }),
  },
  presets: [
    { name: 'Major triad', params: {} },
    { name: 'Minor 7th, open', params: { shape: 'm7', spread: 'open' } },
    { name: 'Power chord', params: { shape: '5' } },
    { name: 'Triads in the song key', params: { source: 'scale', size: 3 } },
    { name: 'Sevenths in the song key', params: { source: 'scale', size: 4 } },
    { name: 'Follow the chord track', params: { source: 'chordTrack', spread: 'close' } },
    { name: 'Octave and fifth', params: { source: 'intervals', add1: 7, add2: 12 } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const out: FxNote[] = [];
    const inversion = Math.round(Number(run.values.inversion));
    for (const note of input) {
      const raw = chordKeys(note, run);
      if (!raw) {
        out.push(note);
        continue;
      }
      const keys = spread(invert(raw, inversion), String(run.values.spread));
      const seen = new Set<number>();
      keys.forEach((key, i) => {
        if (!isPlayableKey(key) || seen.has(key)) return;
        seen.add(key);
        out.push(derivedNote(note, `c${i}`, { key: Math.max(MIN_KEY, Math.min(MAX_KEY, key)) }));
      });
    }
    return out;
  },
};
