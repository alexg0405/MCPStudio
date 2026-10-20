/** Shared shapes of vocal alignment (`align/`): the stretch of sound worked on, and what a run reports. */
import type { KeptSpan } from './lag';

/** The part of a rendered stretch the clip plays: seconds from the start of the stretch. */
export interface AudibleSpan {
  fromSec: number;
  toSec: number;
}

/** What a run of alignment returns. */
export interface AlignOutput {
  /** The aligned sound, as long as the input. */
  channels: Float32Array[];
  /** How much later than the target the clip's sound was at each frame of `hopSec`, seconds (positive = it moved earlier). */
  lagSec: Float32Array;
  hopSec: number;
  /** The stretches of the output where attacks were kept at their own speed. */
  kept: KeptSpan[];
  stats: AlignStats;
}

/** Numbers a run reports (the dialog, the AI and the tests read them). */
export interface AlignStats {
  /** Median and largest |move| over the audible part, milliseconds. */
  medianMoveMs: number;
  maxMoveMs: number;
  /** Seconds of the audible part where the sound moved by more than 5 ms. */
  movedSec: number;
  /** Seconds the clip and the guide are both audible (0 for the grid). */
  overlapSec: number;
  /** Median pitch deviation from the guide before and after, cents (absent without pitch alignment). */
  pitchCentsBefore?: number;
  pitchCentsAfter?: number;
}
