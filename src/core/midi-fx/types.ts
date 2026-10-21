/**
 * The pieces the MIDI effects are built from: the note they pass around, what an effect may look up (the song key, the chord
 * track, the tempo), and the definition of an effect. Pure data and functions, no DOM: the same code runs in the scheduler, in a
 * live key press, in a bake and in tests.
 */
import type { ParamSpecs, ParamValue } from '@agstudio/sdk/params';
import type { ChordSymbol } from '../harmony/chord';
import type { KeyLike } from '../harmony/scale';

/**
 * A note as the MIDI effects see it. Times are ticks on the song's timeline (PPQ 960) and may be fractional after a humanize
 * or an arpeggiator's swing. `end` is Infinity for a key that is still held (live play): its release is not known yet.
 */
export interface FxNote {
  /** Identity: stable between runs of the same notes, so the scheduler can tell a note it already sent. Effects derive new notes' ids from their source's. */
  id: string;
  start: number;
  end: number;
  /** MIDI key 0–127. */
  key: number;
  /** 0–1. */
  velocity: number;
  /** −1…1, kept from the source note. */
  pan?: number;
  /** Fine pitch in cents, kept from the source note. */
  fine?: number;
  /** Release velocity 0–1, kept from the source note. */
  release?: number;
}

/** What an effect may look up while it runs. */
export interface FxContext {
  /** The song key, or null when none is set. */
  key: KeyLike | null;
  /** The chord of the chord track at a tick of the timeline the notes are on, or null in a gap (or when the track is not available). */
  chordAt(tick: number): ChordSymbol | null;
  /** How many ticks `ms` milliseconds are at `tick` (the tempo may change along the song). */
  msToTicks(ms: number, tick: number): number;
  /** True for live play: an effect cannot move a note earlier than the key press. */
  live: boolean;
  /**
   * The value of an automated param at a tick (plain units of the param), or undefined when no automation clip drives it.
   * `slotId` is the id of the slot in the channel's chain.
   */
  automated?(slotId: string, paramId: string, tick: number): number | undefined;
}

/** What an effect gets when it runs on a stretch of notes. */
export interface FxRun {
  /** The span of the timeline whose output matters: an effect only needs to make notes that start in [from, to). */
  readonly from: number;
  readonly to: number;
  /** The slot's values with the defaults filled in. */
  readonly values: Readonly<Record<string, ParamValue>>;
  /** A numeric param at a tick: automation when a clip drives it, else the slot's value. */
  param(name: string, tick: number): number;
  /** Seed for this effect's draws: the slot's `seed` param mixed with the effect's id. */
  readonly seed: number;
  readonly context: FxContext;
}

/** How far an effect can move a note: sooner (`before`) or later (`after`) than its input, in ticks, for the settings in use. */
export interface FxReach {
  before: number;
  after: number;
}

/** A ready-made setting of an effect. */
export interface FxPreset {
  name: string;
  params: Readonly<Record<string, ParamValue>>;
}

/** One kind of MIDI effect: its settings and what it does to notes. */
export interface MidiFxDef {
  /** Stable id stored in projects. */
  readonly id: string;
  /** Plain name for lists and the window. */
  readonly name: string;
  /** One plain sentence: what it does. */
  readonly description: string;
  readonly params: ParamSpecs;
  readonly presets: readonly FxPreset[];
  /** How far the effect moves or adds notes later or sooner than their input, for these values. */
  reach(values: Readonly<Record<string, ParamValue>>): FxReach;
  /**
   * Turns notes into notes. `input` holds every note that can matter (sorted by start); the result may be in any order. It need
   * not (and for effects that generate notes, must not) make notes outside the run's span: the chain filters what is left.
   */
  run(input: readonly FxNote[], run: FxRun): FxNote[];
}
