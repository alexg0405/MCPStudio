/**
 * The shapes of the sheet-music engraver: what goes in (a part's notes and the song's meter and key) and what comes out
 * (a score of staves, measures, voices and items, with no coordinates: `render/layout.ts` places them).
 *
 * Pitches are written the way sheet music names them: middle C (MIDI 60) is C4. The rest of the app numbers octaves the
 * way FL Studio does (middle C is C5), so the sheet-music window says so in its help.
 */
import type { ChannelId, NoteId, Tick, TimeSignature } from '../model/types';

/** One note handed to the engraver. `key` is the MIDI key (a General MIDI drum key for a percussion part). */
export interface NotationNote {
  id: NoteId;
  channelId: ChannelId;
  /** Pattern ticks (960 per quarter note). */
  tick: Tick;
  length: Tick;
  key: number;
  /** 0 to 1. */
  velocity: number;
}

/** A syllable of the lyrics, in pattern ticks. */
export interface NotationLyric {
  tick: Tick;
  length: Tick;
  text: string;
  /** True when the word goes on in the next syllable (a hyphen is drawn). */
  continues: boolean;
}

/** A chord symbol over a stretch of the pattern, already spelled ("Am7"). */
export interface NotationChord {
  tick: Tick;
  length: Tick;
  text: string;
}

/** The smallest note value the engraver rounds starts and ends to. Triplets are found on their own. */
export type NotationGrid = '1/8' | '1/16' | '1/32';
/** Every grid choice, coarsest first. */
export const NOTATION_GRIDS: readonly NotationGrid[] = ['1/8', '1/16', '1/32'];

/** Which clefs to use: chosen from the range of the notes, or forced. */
export type ClefChoice = 'auto' | 'treble' | 'bass' | 'grand';

/** What `engrave` reads. */
export interface EngraveInput {
  notes: readonly NotationNote[];
  /** True for a drum part: General MIDI drum keys on a one-line percussion staff. */
  isPercussion: boolean;
  /** The length of the pattern, in ticks (the score has at least this many bars). */
  lengthTicks: Tick;
  timeSig: TimeSignature;
  /** The song key; undefined = C major without a key signature. */
  key?: { root: number; scale: string };
  bpm: number;
  grid: NotationGrid;
  clef: ClefChoice;
  lyrics?: readonly NotationLyric[];
  chords?: readonly NotationChord[];
  /** Mark loudness changes from the velocities. */
  dynamics?: boolean;
}

/** A clef drawn at the start of a staff. */
export type ClefKind = 'treble' | 'bass' | 'percussion';

/** The key signature: sharps (positive) or flats (negative), and the name for display. */
export interface KeySignature {
  fifths: number;
  /** "G major", "A minor", "C major" (no key set). */
  name: string;
}

/** One of the seven letters, as 0 (C) to 6 (B). */
export type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A written note name: letter, accidental (-2 to 2 semitones) and octave (middle C is C4). */
export interface Spelling {
  step: Step;
  alter: number;
  octave: number;
}

/** What a note shows next to its head. */
export type AccidentalSign = 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'double-flat';

/** Notehead shapes. Percussion uses the crossed and diamond ones. */
export type HeadShape = 'normal' | 'x' | 'diamond';

/** A plain note value: its denominator (1 whole, 2 half, 4 quarter, 8 eighth ... 64) and dots. */
export interface NoteValue {
  base: 1 | 2 | 4 | 8 | 16 | 32 | 64;
  dots: 0 | 1;
}

/** One notehead of a chord. */
export interface Head {
  noteId: NoteId;
  channelId: ChannelId;
  key: number;
  /** 0 to 1, the loudness of the note (marks the dynamics). */
  velocity: number;
  spelling: Spelling;
  /** Diatonic position: octave * 7 + step (E4 = 30), the vertical place on the staff before the clef is applied. */
  position: number;
  accidental: AccidentalSign | null;
  /** The accidental is a reminder (drawn in brackets). */
  isCourtesy: boolean;
  shape: HeadShape;
  /** Drawn on the other side of the stem (a second inside a chord). */
  isDisplaced: boolean;
  /** Drawn with a small "o" above (an open hi-hat). */
  isOpen: boolean;
  tiesToNext: boolean;
  tiedFromPrevious: boolean;
}

/** Inside a tuplet: `actual` notes in the time of `normal`, and where its bracket starts and ends. */
export interface TupletInfo {
  actual: number;
  normal: number;
  /** Start of the tuplet span in the measure (ticks): the bracket covers the span. */
  spanTick: Tick;
  spanTicks: Tick;
}

/** A group of notes sounding together (one notehead is a chord of one). */
export interface ChordItem {
  kind: 'chord';
  /** Start inside the measure, in ticks. */
  tick: Tick;
  /** Real length in ticks. */
  ticks: Tick;
  value: NoteValue;
  /** Set inside a triplet: the notes of the group show a bracket with this ratio. */
  tuplet: TupletInfo | null;
  /** Heads from the lowest to the highest. */
  heads: Head[];
  stem: 'up' | 'down' | 'none';
  /** Beam group id inside the voice's measure, or null. */
  beamId: number | null;
  /** How many beams or flags this note has (1 for an eighth, 2 for a sixteenth...). */
  flags: number;
  /** A dynamic mark to draw under the staff here ("mf"). */
  dynamic: string | null;
  /** The lyric syllable under this note. */
  lyric: { text: string; continues: boolean } | null;
}

/** A rest. */
export interface RestItem {
  kind: 'rest';
  tick: Tick;
  ticks: Tick;
  value: NoteValue;
  tuplet: TupletInfo | null;
  /** The rest fills the whole bar (drawn centred as a whole rest, whatever the meter). */
  isWholeBar: boolean;
}

/** A chord or a rest. */
export type Item = ChordItem | RestItem;

/** One voice of a staff in a measure, in time order, filling the bar. */
export interface Voice {
  /** 1 (stems up when there are two) or 2 (stems down). */
  number: 1 | 2;
  items: Item[];
}

/** One staff in one measure. */
export interface StaffMeasure {
  voices: Voice[];
}

/** A bar across all staves. */
export interface Measure {
  /** 0-based bar number. */
  index: number;
  startTick: Tick;
  ticks: Tick;
  staves: StaffMeasure[];
  /** Chord symbols that start in this bar. */
  chordSymbols: Array<{ tick: Tick; text: string }>;
}

/** The score `engrave` makes. */
export interface Score {
  timeSig: TimeSignature;
  keySignature: KeySignature;
  bpm: number;
  isPercussion: boolean;
  /** One clef per staff, top to bottom. */
  clefs: ClefKind[];
  measures: Measure[];
  /** How many overlapping notes had to be simplified because a staff holds two voices at most. */
  simplified: number;
  hasLyrics: boolean;
}
