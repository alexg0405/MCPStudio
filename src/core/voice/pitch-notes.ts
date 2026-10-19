/**
 * Sung-pitch analysis for the pitch editor: the YIN track of a recording (`trackPitch`), cleaned
 * (octave slips and short dropouts repaired), cut into notes with the pitch they were sung at, how
 * much each drifts and how much vibrato it has. Pure, no DOM; runs in a Worker or in Node.
 *
 * Notes: a run of voiced frames is one note until its (median-filtered) pitch leaves the note's
 * running centre by 65 cents and settles on a new level for 50 ms; the boundary is put where the
 * glide began. Unvoiced gaps of 30 ms or more (a consonant, a breath) end a note. Pieces under
 * 40 ms join their neighbour, notes under 30 ms of pitched sound are dropped. Thresholds are in
 * `PITCH_NOTE_THRESHOLDS`.
 *
 * The steps live in `pitch-notes/` (`clean.ts`, `segment.ts`, `note-stats.ts`, shared types in
 * `shared.ts`); this file keeps the import path every caller uses and the two entry points.
 */
import { repairOctaveSlips } from './octave';
import { trackPitch } from './pitch';
import { cleanF0 } from './pitch-notes/clean';
import { segmentNotes } from './pitch-notes/segment';
import type { PitchFrames, PitchNote } from './pitch-notes/shared';

export { cleanF0 } from './pitch-notes/clean';
export { noteStats, slowLine } from './pitch-notes/note-stats';
export { segmentNotes } from './pitch-notes/segment';
export { PITCH_NOTE_THRESHOLDS, framesToCents, type PitchFrames, type PitchNote } from './pitch-notes/shared';

export interface PitchAnalysis extends PitchFrames {
  notes: PitchNote[];
}

/**
 * The version of the analysis (tracker, cleaning, octave repair, segmentation): stored analyses carry it in their key, so a
 * change that can alter a result bumps it and old entries are ignored and deleted. 1: first release; 2: octave repair.
 */
export const PITCH_ANALYSIS_VERSION = 2;

export interface AnalyzeOptions {
  /** Where the first sample of the audio is on the recording's timeline, seconds (default 0). */
  start?: number;
  /** The range of voices to look for, Hz (default 65–1100). */
  minHz?: number;
  maxHz?: number;
  /** Repair notes the tracker read an octave or more high (default true; tests turn it off to measure the tracker alone). */
  repairOctaves?: boolean;
}

/** What `trackVoicePitch` makes of a mono signal. */
export interface VoicePitch {
  /** Cleaned and octave-repaired fundamental per frame, Hz (0 = unvoiced). */
  f0: Float32Array;
  conf: Float32Array;
  /** Seconds between frames. */
  hop: number;
  /** Frames moved down because the tracker read them an octave (or more) above the sound's fundamental. */
  repaired: number;
}

/** The pitch tracker looks for voices from 65 Hz to 1100 Hz, in frames of 5 ms. */
const DEFAULT_MIN_HZ = 65;
const DEFAULT_MAX_HZ = 1100;
const FRAME_HOP_SEC = 0.005;

/**
 * The pitch track the editor and the renderer both use: YIN (`trackPitch`), cleaned (`cleanF0`), then notes whose
 * fundamental the tracker read an octave (or an octave and a fifth) high are moved down where a short-window spectrum
 * shows the lower fundamental's lines (`octave.ts`). Deterministic.
 */
export function trackVoicePitch(
  mono: Float32Array,
  sampleRate: number,
  opts: { minHz?: number; maxHz?: number; repairOctaves?: boolean } = {},
): VoicePitch {
  const hop = Math.max(1, Math.round(FRAME_HOP_SEC * sampleRate));
  const track = trackPitch(mono, sampleRate, {
    minHz: opts.minHz ?? DEFAULT_MIN_HZ,
    maxHz: opts.maxHz ?? DEFAULT_MAX_HZ,
    hop,
  });
  const clean = cleanF0(track.f0, track.confidence);
  const hopSec = hop / sampleRate;
  const repaired = opts.repairOctaves === false ? 0 : repairOctaveSlips(mono, sampleRate, clean.f0, hop);
  return { f0: clean.f0, conf: clean.conf, hop: hopSec, repaired };
}

/** Tracks and segments the pitch of a mono recording. */
export function analyzePitch(mono: Float32Array, sampleRate: number, opts: AnalyzeOptions = {}): PitchAnalysis {
  const v = trackVoicePitch(mono, sampleRate, opts);
  const frames: PitchFrames = { t0: opts.start ?? 0, hop: v.hop, f0: v.f0, conf: v.conf };
  return { ...frames, notes: segmentNotes(frames) };
}
