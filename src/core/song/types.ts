/**
 * The types the song generator passes between its steps: what was asked for, the pieces a song is built from (patterns of
 * four bars that play in sections) and the finished plan. Everything is in 1/16 steps (16 to a bar), the grid of `BeatSpec`.
 */
import type { SectionRole } from '../arrange/sections';
import type { BeatSpec } from '../beat/spec';
import type { Style } from '../beat/style';
import type { ChordSymbol } from '../harmony/chord';
import type { Mood } from '../harmony/progressions';

/** A song key: the tonic's pitch class (0 to 11) and whether it is minor. */
export interface SongKey {
  root: number;
  minor: boolean;
}

/** What the generator was asked for, after the words of the request were read and the gaps filled in from the seed. */
export interface SongRequest {
  style: Style;
  bpm: number;
  key: SongKey;
  mood: Mood;
  /** The length the musician asked for, in bars; undefined means the style's usual song. */
  bars?: number;
  /** The same seed always gives the same song. */
  seed: number;
  /** −1 (simpler) … +1 (busier), read from the words. */
  density: number;
  /** Whether the request names the drums or the melody it wants left out. */
  noHats: boolean;
}

/** A chord placed in a pattern: where it starts and how long it lasts (1/16 steps from the pattern's start). */
export interface PlacedChord {
  step: number;
  length: number;
  chord: ChordSymbol;
}

/** One pattern of the song: a beat spec (up to four bars), the chords it plays over and what kind of part it is. */
export interface SongPattern {
  /** The reference sections use ("@verse"). */
  ref: string;
  spec: BeatSpec;
  /** The chords under the pattern, so the quality checks can read them without re-deriving them. */
  chords: PlacedChord[];
  /** A band is drums, bass and chords; a melody is one lead line over the same chords. */
  kind: 'band' | 'melody';
}

/** A section of the song: its length, energy and the patterns that play in it. */
export interface SongSection {
  name: string;
  role: SectionRole;
  bars: number;
  /** 1 (sparse) … 5 (everything). */
  energy: number;
  /** References of the patterns that play. */
  play: string[];
  /** Parts left out of those patterns (the arrange action's `without`). */
  without: string[];
}

/** The chords of the whole song as the chord track takes them: names, and how many bars each name lasts. */
export interface ChordLine {
  text: string;
  barsPerChord: number;
}

/** A finished song, before any of it is written into a project. */
export interface SongPlan {
  title: string;
  /** What was made, in a sentence for the chat. */
  message: string;
  request: SongRequest;
  style: Style;
  bpm: number;
  swing: number;
  key: SongKey;
  /** The stock progression the verse and chorus are built on. */
  progression: { id: string; name: string };
  patterns: SongPattern[];
  sections: SongSection[];
  chordLine: ChordLine;
}
