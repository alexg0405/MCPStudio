/**
 * What DJ mode knows about a song (a sample the musician imported): its tempo and beat grid, key,
 * energy over time, loudness and where to mix in and out. Computed once per file (by its content
 * hash) in a Worker and cached; the auto-mix planner and the decks read it.
 */

/** Camelot wheel position: 1–12 plus A (minor) or B (major), e.g. "8A" = A minor. */
export type Camelot = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}${'A' | 'B'}`;

export interface TrackKey {
  /** Pitch class of the tonic, 0 = C … 11 = B. */
  root: number;
  mode: 'major' | 'minor';
  camelot: Camelot;
  /** 0–1: how clearly the audio fits that key (low for drum tracks, atonal or key-changing songs). */
  confidence: number;
}

export interface BeatGrid {
  /** Beats per minute (octave-corrected, to 0.01). */
  bpm: number;
  /** Time of the first downbeat (beat 1 of a bar) in source seconds. */
  firstDownbeat: number;
  /** Beats per bar (4 almost always). */
  beatsPerBar: number;
  /** 0–1: how well a fixed grid fits the whole song (low = live drummer, tempo changes, no clear beat). */
  confidence: number;
  /**
   * Beat times in source seconds when the tempo drifts (a fixed grid would slip); empty when the song
   * is grid-locked (most electronic and modern pop/hip-hop).
   */
  beats: number[];
}

/** A point where the song changes energy: phrase boundaries that make good mix points. */
export interface Section {
  /** Source seconds. */
  start: number;
  end: number;
  /** 0–1 relative energy (loudness and density in this song). */
  energy: number;
  kind: 'intro' | 'build' | 'drop' | 'break' | 'verse' | 'outro' | 'body';
}

export interface TrackAnalysis {
  /** The analysis code's version: a newer version re-analyzes. */
  version: number;
  /** Content hash of the file (the sample's hash). */
  hash: string;
  durationSec: number;
  grid: BeatGrid | null;
  key: TrackKey | null;
  /** Integrated loudness (LUFS) and true peak (dBTP) of the whole song. */
  lufs: number;
  truePeakDb: number;
  /** Energy 0–1, one value per bar (on the grid) or per 2 s without one. */
  energy: number[];
  sections: Section[];
  /** Good places to start mixing this song in, and to start mixing out of it (source seconds, on downbeats). */
  mixIn: number;
  mixOut: number;
}

export const ANALYSIS_VERSION = 1;
