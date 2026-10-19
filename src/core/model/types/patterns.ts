import type { ChannelId, NoteId, PatternId, Tick } from './ids';

/** A pattern of notes (the unit the channel rack and the piano roll edit, and pattern clips play). */
export interface Pattern {
  id: PatternId;
  name: string;
  color: string;
  /** Width of the channel-rack step grid (16 = one 4/4 bar). */
  stepCount: number;
  /** Explicit length; undefined = derived from content (whole bars, at least one). */
  length?: Tick;
  /** Notes per channel; a missing key means the channel has no notes in this pattern. */
  notes: Record<ChannelId, Record<NoteId, Note>>;
  /**
   * A variation the arranger made of another pattern ("Drop · fill + slide"): where it came from and
   * what was changed. It is rebuilt when its source changes, unless its notes were edited by hand
   * (they no longer match `hash`). Absent for ordinary patterns. Added in v3 (optional).
   */
  derived?: PatternDerivation;
}

/** Where a variant pattern came from (see `Pattern.derived`). */
export interface PatternDerivation {
  /** The pattern it varies (the editable source). */
  from: PatternId;
  /** The changes, applied to the source's notes in order. */
  steps: VariantStep[];
  /** Seed of the variation's choices (velocity jitter), so a rebuild sounds the same. */
  seed: number;
  /** Hash of the notes as the arranger wrote them (`notesHash`); different notes = edited by hand. */
  hash: string;
}

/** What a variant step does to its span (see `core/arrange/fills.ts`). */
export const VARIANT_KINDS = [
  'snare-fill',
  'tom-fill',
  'hat-fill',
  'kick-fill',
  'snare-build',
  'hat-roll',
  'open-hat',
  'slide',
  'gap',
  'dropout',
  'stutter',
  'thin',
  'double-hats',
  'without',
  'clear-drums',
] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

/** One change a variant makes to its source, over a span of the pattern. */
export interface VariantStep {
  kind: VariantKind;
  /** Pattern ticks, [from, to). */
  from: Tick;
  to: Tick;
  /**
   * For a change spread over several clips (a 4-bar snare build over 2-bar loops): where this part
   * starts inside the whole change, and the whole change's length.
   */
  offset?: Tick;
  total?: Tick;
  /** 1–5: the section's energy (velocities scale with it). */
  energy?: number;
  /** thin: 1 (lighter) or 2 (sparse). */
  level?: number;
  /** without: channel ids or parts (kick, snare, hats, perc, crash, drums, 808, bass, chords, lead, music, fx). */
  parts?: string[];
}

/** One note of a pattern. */
export interface Note {
  id: NoteId;
  /** Pattern-relative start. */
  tick: Tick;
  /** ≥ 1 tick. */
  length: Tick;
  key: number;
  /** 0–1. */
  velocity: number;
  pan?: number;
  muted?: boolean;
  /** Release velocity 0–1 (FL's "release"); absent = 0.5. */
  release?: number;
  /** Fine pitch in cents, −100…100; absent = 0. */
  fine?: number;
}
