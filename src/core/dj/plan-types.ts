/**
 * The types of the auto-mix planner (`plan.ts`): what goes in (songs, options) and what comes out (the plan).
 */
import type { Tick } from '../model/types';
import type { EnergyShape } from './order';
import type { Camelot, TrackAnalysis } from './types';
import type { HarmonicMove } from './wheel';

export type MixOrder = 'keep' | 'auto';
export type MixTransitionStyle = 'auto' | 'smooth' | 'quick' | 'cut';
export type TransitionRecipe = 'bass-swap' | 'filter' | 'echo' | 'cut';
export const TRANSITION_RECIPES: readonly TransitionRecipe[] = ['bass-swap', 'filter', 'echo', 'cut'];
/** The overlap lengths (bars) the transition list offers; 0 is a cut. */
export const TRANSITION_LENGTHS: readonly number[] = [0, 4, 8, 16, 32];
/** The two decks a mix alternates between. */
export type Deck = 'A' | 'B';

/** A song to mix: the caller's id, a title, and what the analysis found. */
export interface MixTrackInput {
  /** The caller's id (the library song or sample). */
  id: string;
  /** "Artist – Title", or the file name. */
  title: string;
  analysis: TrackAnalysis;
  /** Auto order keeps it at its position in the input. */
  pinned?: boolean;
}

/** A change to one transition, by the incoming song's id. */
export interface TransitionTweak {
  /** Overlap in bars (0 = a cut). */
  bars?: number;
  recipe?: TransitionRecipe;
  riser?: boolean;
}

/** How a mix is planned. */
export interface MixOptions {
  order: MixOrder;
  energy: EnergyShape;
  /** 'follow': each song at its own tempo, ramping during transitions; a number: the whole mix at that BPM. */
  mixTempo: 'follow' | number;
  transition: MixTransitionStyle;
  /** Aim for about this many minutes (songs mix out earlier, by whole phrases). */
  lengthTargetMin?: number;
  /** Keep each song's pitch when its tempo changes (time-stretch) instead of turntable-style. */
  keyLock?: boolean;
  tweaks?: Readonly<Record<string, TransitionTweak>>;
}

/** What the planner does when it is told nothing: chosen order, a party energy shape, tempo following each song. */
export const DEFAULT_MIX_OPTIONS: MixOptions = { order: 'auto', energy: 'party', mixTempo: 'follow', transition: 'auto' };

/** One piece of a song on the playlist (a song is cut into pieces where a stretched tempo changes). */
export interface PlannedClip {
  start: Tick;
  length: Tick;
  /** Seconds into the song where this piece starts. */
  offsetSec: number;
}

/** A song as placed in the mix. */
export interface PlannedSong {
  id: string;
  title: string;
  /** Position in the mix, 0-based. */
  index: number;
  deck: Deck;
  /** The tempo its beats are counted at (the channel's source BPM): its own, or half/double for a half-time match. */
  bpm: number;
  nativeBpm: number | null;
  factor: 0.5 | 1 | 2;
  /** False for songs without a steady beat: they play at their own speed and are cut in and out. */
  beatMatched: boolean;
  /** How the song follows the mix tempo: like a turntable, time-stretched, or not at all (no beat). */
  follow: 'resample' | 'stretch' | 'off';
  start: Tick;
  end: Tick;
  sourceIn: number;
  sourceOut: number;
  /** Pieces split where the tempo changes. */
  clips: PlannedClip[];
  tempoStart: number;
  tempoEnd: number;
  /** Level match to the other songs (clip gain). */
  gainDb: number;
  /** Fade at its end (seconds), when the mix ends before the song does. */
  fadeOutSec?: number;
  key: Camelot | null;
  /** Overall energy 0–1 (`trackEnergy`). */
  energy: number;
}

/** The hand-over from one song to the next. */
export interface PlannedTransition {
  index: number;
  from: string;
  to: string;
  fromDeck: Deck;
  toDeck: Deck;
  /** The downbeat both songs are on when the incoming one starts. */
  start: Tick;
  /** Overlap (0 for a cut). */
  length: Tick;
  bars: number;
  recipe: TransitionRecipe;
  riser: boolean;
  /** Where the bass swaps (or the outgoing song stops). */
  swap: Tick;
  move: HarmonicMove;
  /** The tempo change as a share (0.03 = 3 %). */
  tempoChange: number;
  /** Plain words for the transitions list. */
  why: string;
}

export type DeckControl = 'volume' | 'low-cut' | 'high-cut' | 'filter' | 'echo';
export type DjPurpose = 'fade-in' | 'fade-out' | 'bass-in' | 'bass-out' | 'filter-out' | 'echo-out';

/**
 * A curve on a deck control. Point values: volume as a factor of the fader's own level (1 = where it
 * sits), low cut / high cut / filter in Hz, echo as the send's gain; 'neutral' = where the control sits.
 */
export interface DjAutomation {
  transition: number;
  deck: Deck;
  control: DeckControl;
  purpose: DjPurpose;
  start: Tick;
  length: Tick;
  points: { at: Tick; value: number | 'neutral' }[];
}

/** A riser sound that builds into a swap. */
export interface PlannedRiser {
  transition: number;
  start: Tick;
  beats: number;
  /** Tempo at its start (its sample is made for it). */
  bpm: number;
}

/** The tempo from a tick on. */
export interface TempoPoint {
  tick: Tick;
  bpm: number;
}

/** A whole planned mix: everything `app/dj/mix.ts` writes into the project. */
export interface MixPlan {
  songs: PlannedSong[];
  transitions: PlannedTransition[];
  automation: DjAutomation[];
  risers: PlannedRiser[];
  markers: { tick: Tick; name: string; song: string }[];
  /** Piecewise constant from tick 0 (as the song's tempo map has it: glides in 1/16 steps). */
  tempo: TempoPoint[];
  /** The tempo curve to write: points from tick 0; `ramp` glides linearly to the next point, else it holds. */
  tempoCurve: (TempoPoint & { ramp: boolean })[];
  /** Set when the whole mix plays at one tempo. */
  fixedTempo: number | null;
  totalTicks: Tick;
  durationSec: number;
  warnings: string[];
}
