import { median } from './math';
import type { PitchFrames } from './pitch-frames';
import { HOP_SEC, VOICE_THRESHOLDS } from './thresholds';
import type { Measured, Onset } from './types';

const T = VOICE_THRESHOLDS;

/** Measures the sound between two onsets (the analysis's `measure` step). */
export type MeasureSpan = (onset: Onset, prevSec: number, endSec: number) => Measured;

/** A merge needs the earlier event to still be sounding within this much of its end (s). */
const STILL_SOUNDING_SEC = 0.02;
/** A later non-tonal event merges into a hum when it is at least this periodic. */
const MERGEABLE_PERIODICITY = 0.6;

/** The pitch track is smoothed with a median over this many frames each side (5 frames, ~25 ms)… */
const SMOOTHING_FRAMES_EACH_SIDE = 2;
/** …and a frame needs at least this many pitched neighbours to keep a value. */
const SMOOTHING_MIN_PITCHED = 3;
/** A stable region needs at least this share of its frames pitched. */
const STABLE_MIN_PITCHED_SHARE = 0.8;
/** A region grows while frames stay within `stableSemitones` plus this (semitones)… */
const GROW_EXTRA_SEMITONES = 0.25;
/** …and tolerates this many unpitched frames in a row. */
const GROW_MAX_GAP_FRAMES = 4;
/** Two regions closer than this (s) are one quick change, cut where the pitch crosses their midpoint. */
const QUICK_CHANGE_SEC = 0.08;
/** The midpoint search starts this many frames before the first region's end (YIN smears the change both ways). */
const MIDPOINT_SEARCH_LEAD_FRAMES = 2;

/** A stretch of the pitch track where the pitch holds still. */
interface StableRegion {
  start: number;
  end: number;
  /** Median MIDI pitch. */
  pitch: number;
}

/** Drops onsets inside a still-sustained tonal event that don't come with a real level rise. */
export function mergeLegato(events: Measured[], measure: MeasureSpan): Measured[] {
  const out: Measured[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && isLegatoContinuation(prev, event)) {
      out[out.length - 1] = measure(prev.onset, prev.prev, event.end);
      continue;
    }
    out.push(event);
  }
  return out;
}

/** Whether `event` is the same breath as the tonal event before it: no new attack, and it is still sounding. */
function isLegatoContinuation(prev: Measured, event: Measured): boolean {
  return (
    prev.kind === 'tonal' &&
    event.onset.fullRiseDb < T.legatoRiseDb &&
    (event.kind === 'tonal' || event.features.periodicity >= MERGEABLE_PERIODICITY) &&
    prev.sustainSec >= prev.end - prev.onset.time - STILL_SOUNDING_SEC
  );
}

/** Splits tonal events at legato note changes. */
export function splitByPitch(events: Measured[], measure: MeasureSpan, pitch: PitchFrames): Measured[] {
  const out: Measured[] = [];
  for (const event of events) {
    const cuts = event.kind === 'tonal' ? noteChanges(event, pitch) : [];
    if (cuts.length === 0) {
      out.push(event);
      continue;
    }
    let onset = event.onset;
    let prev = event.prev;
    for (const end of [...cuts, event.end]) {
      const piece = measure(onset, prev, end);
      piece.kind = 'tonal';
      piece.confidence = event.confidence;
      out.push(piece);
      prev = onset.time;
      onset = { time: end, flux: 0, riseDb: 0, fullRiseDb: 0, split: true };
    }
  }
  return out;
}

/**
 * Note changes inside a tonal event (s). Stable regions = runs of ≥ 60 ms where the smoothed pitch
 * stays put; neighbouring regions more than 1.5 semitones apart are different notes. The cut is
 * where the pitch crosses the midpoint for quick changes (YIN smears both ways), or where it
 * arrives for long glides (so the first note carries the slide).
 */
function noteChanges(event: Measured, pitch: PitchFrames): number[] {
  const { from, midi } = pitch.midiTrack(event.onset.time, event.end, event.peak);
  const hold = Math.max(3, Math.round(T.splitHoldSec / HOP_SEC));
  if (midi.length < 2 * hold) return [];
  const smoothed = smoothPitch(midi);
  const regions = findStableRegions(smoothed, hold);
  const cuts = regionBoundaries(regions, smoothed).map((frame) => pitch.frameTime(from + frame));
  return dropCrowdedCuts(cuts, event);
}

/** Median of 5 frames; NaN where fewer than 3 of them are pitched. */
function smoothPitch(midi: Float64Array): Float64Array {
  const smoothed = new Float64Array(midi.length);
  for (let i = 0; i < midi.length; i++) {
    const pitched: number[] = [];
    const last = Math.min(midi.length - 1, i + SMOOTHING_FRAMES_EACH_SIDE);
    for (let j = Math.max(0, i - SMOOTHING_FRAMES_EACH_SIDE); j <= last; j++) {
      if (!Number.isNaN(midi[j] as number)) pitched.push(midi[j] as number);
    }
    smoothed[i] = pitched.length >= SMOOTHING_MIN_PITCHED ? median(pitched) : NaN;
  }
  return smoothed;
}

/** The pitched values of smoothed[from, to). */
function pitchedIn(smoothed: Float64Array, from: number, to: number): number[] {
  return Array.from(smoothed.subarray(from, to)).filter((v) => !Number.isNaN(v));
}

/**
 * The median pitch of the `hold` frames from `start` if they hold still (all within
 * `stableSemitones` of it, and the second half no more than `stableDrift` from the first); NaN if not.
 */
function stablePitchAt(smoothed: Float64Array, start: number, hold: number): number {
  const values = pitchedIn(smoothed, start, start + hold);
  if (values.length < STABLE_MIN_PITCHED_SHARE * hold) return NaN;
  const middle = median(values);
  if (values.some((v) => Math.abs(v - middle) > T.stableSemitones)) return NaN;
  const half = hold >> 1;
  const firstHalf = median(pitchedIn(smoothed, start, start + half));
  const secondHalf = median(pitchedIn(smoothed, start + hold - half, start + hold));
  if (Math.abs(secondHalf - firstHalf) > T.stableDrift) return NaN;
  return middle;
}

/** Runs of at least `hold` frames where the pitch holds still, grown while the pitch stays close. */
function findStableRegions(smoothed: Float64Array, hold: number): StableRegion[] {
  const regions: StableRegion[] = [];
  for (let i = 0; i + hold <= smoothed.length;) {
    const pitch = stablePitchAt(smoothed, i, hold);
    if (Number.isNaN(pitch)) {
      i++;
      continue;
    }
    let end = i + hold;
    let gap = 0;
    while (end < smoothed.length) {
      const v = smoothed[end] as number;
      if (!Number.isNaN(v) && Math.abs(v - pitch) <= T.stableSemitones + GROW_EXTRA_SEMITONES) gap = 0;
      else if (Number.isNaN(v) && gap < GROW_MAX_GAP_FRAMES) gap++;
      else break;
      end++;
    }
    end -= gap;
    regions.push({ start: i, end, pitch });
    i = end;
  }
  return regions;
}

/**
 * The frame of each change between neighbouring regions more than 1.5 semitones apart. Neighbours
 * only: a slow glide is a chain of close regions and stays one note.
 */
function regionBoundaries(regions: StableRegion[], smoothed: Float64Array): number[] {
  const cuts: number[] = [];
  for (let r = 1; r < regions.length; r++) {
    const before = regions[r - 1] as StableRegion;
    const after = regions[r] as StableRegion;
    if (Math.abs(after.pitch - before.pitch) <= T.splitSemitones) continue;
    cuts.push(changeFrame(before, after, smoothed));
  }
  return cuts;
}

/**
 * Where the pitch changes between two regions: for a quick change, the first frame that crosses
 * the midpoint (YIN smears both ways); for a long glide, where the new region starts.
 */
function changeFrame(before: StableRegion, after: StableRegion, smoothed: Float64Array): number {
  if (after.start - before.end > Math.round(QUICK_CHANGE_SEC / HOP_SEC)) return after.start;
  const midpoint = (before.pitch + after.pitch) / 2;
  const isRising = after.pitch > before.pitch;
  for (let j = Math.max(0, before.end - MIDPOINT_SEARCH_LEAD_FRAMES); j <= after.start; j++) {
    const v = smoothed[j] as number;
    if (!Number.isNaN(v) && (isRising ? v >= midpoint : v <= midpoint)) return j;
  }
  return after.start;
}

/** Drops cuts that leave a piece shorter than the hold time at either end of the event. */
function dropCrowdedCuts(cuts: number[], event: Measured): number[] {
  const kept: number[] = [];
  for (const cut of cuts) {
    const last = kept.length > 0 ? (kept[kept.length - 1] as number) : event.onset.time;
    if (cut - last >= T.splitHoldSec && event.end - cut >= T.splitHoldSec) kept.push(cut);
  }
  return kept;
}
