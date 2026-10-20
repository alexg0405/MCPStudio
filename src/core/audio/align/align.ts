/**
 * Vocal alignment: moves the syllables of a clip (a double, a backing vocal, an ad-lib) onto the timing of a guide
 * (the lead), and optionally its pitch onto the guide's pitch contour. Steps:
 *
 *  1. describe both voices every 5 ms (`features.ts`) over the same time axis,
 *  2. match them with a banded dynamic time warp (`dtw.ts`),
 *  3. turn the path into a smooth, speed-limited lag curve that keeps attacks sharp (`lag.ts`),
 *  4. play the clip along the curve with WSOLA, so its pitch is kept (`warp-render.ts`),
 *  5. pull its pitch towards the guide's with TD-PSOLA (`pitch-follow.ts`).
 *
 * Pure functions of plain arrays: deterministic, no DOM, so the app's Worker and the tests run the same code.
 * "Tighten timing to the grid" (`grid.ts`) shares steps 3 and 4.
 */
import { monoMix } from '../pitch-edit/render';
import { bandedDtw } from './dtw';
import { ALIGN_HOP_SEC, FEATURE_DIM, frameFeatures, type FrameFeatures } from './features';
import { lagFromPath, shapeLag, tightnessSettings } from './lag';
import { syllableOnsets } from './onsets';
import { followGuidePitch } from './pitch-follow';
import type { AlignOutput, AlignStats, AudibleSpan } from './types';
import { renderLag } from './warp-render';

/** The largest move the match may make either way, seconds (sets the band, so the memory). */
export const MAX_ALIGN_SHIFT_SEC = 0.5;
/** Longest stretch aligned in one piece, seconds (the band's trace table grows with it). */
export const MAX_ALIGN_SECONDS = 15 * 60;
/** Where frames count as moved. */
const MOVED_SEC = 0.005;
/** Reliability of a frame where neither voice sounds, against 1 where both do. */
const SILENT_WEIGHT = 0.03;
/** Share of the progress each step takes. */
const FEATURES_SHARE = 0.25;
const MATCH_SHARE = 0.2;
const RENDER_SHARE = 0.35;

/** The guide voice: its mono samples on the clip's time axis (index 0 = the start of the clip's stretch). */
export interface GuideVoice {
  mono: Float32Array;
  sampleRate: number;
  /** The part of it that is audible (seconds from the start of the stretch). */
  audible: AudibleSpan;
}

/** What `alignToGuide` needs. */
export interface AlignInput {
  /** The clip's sound over the stretch to render (planar). */
  channels: readonly Float32Array[];
  sampleRate: number;
  /** The part of the stretch the clip plays. */
  audible: AudibleSpan;
  guide: GuideVoice;
  /** 0..100: how closely to follow (0 = only big offsets, 100 = syllable by syllable). */
  tightness: number;
  /** 0..100: how much of the pitch deviation from the guide to correct. */
  pitch: number;
  /** Called now and then with 0..1. */
  onProgress?: (fraction: number) => void;
  /** Largest move either way, seconds (default `MAX_ALIGN_SHIFT_SEC`). */
  maxShiftSec?: number;
}

/** Number of frames of a stretch (one more than the hops so the last sample has a frame). */
export function frameCount(lengthFrames: number, sampleRate: number): number {
  return Math.ceil(lengthFrames / sampleRate / ALIGN_HOP_SEC) + 1;
}

/** Seconds the two audible spans share. */
export function overlapOf(a: AudibleSpan, b: AudibleSpan): number {
  return Math.max(0, Math.min(a.toSec, b.toSec) - Math.max(a.fromSec, b.fromSec));
}

/**
 * The frames' vectors with `pad` frames of silence on both sides, so a clip that has to move by more than the time before
 * its first sound can be matched at any offset (the path may begin in the silence).
 */
function paddedVectors(vectors: Float32Array, frames: number, pad: number): Float32Array {
  const padded = new Float32Array((frames + 2 * pad) * FEATURE_DIM);
  padded.set(vectors.subarray(0, frames * FEATURE_DIM), pad * FEATURE_DIM);
  return padded;
}

/** The DTW over both voices padded with silence; returns the clip frame (on the unpadded axis, may be outside it) of each guide frame. */
function matchVoices(guide: FrameFeatures, clip: FrameFeatures, frames: number, opts: { halfBand: number; stepPenalty: number; onProgress?: (f: number) => void }): Float32Array {
  const pad = 2 * opts.halfBand;
  const total = frames + 2 * pad;
  const padActivity = (activity: Float32Array) => {
    const padded = new Float32Array(total);
    padded.set(activity.subarray(0, frames), pad);
    return padded;
  };
  const path = bandedDtw(paddedVectors(guide.vectors, frames, pad), paddedVectors(clip.vectors, frames, pad), total, {
    ...opts,
    guideActivity: padActivity(guide.activity),
    clipActivity: padActivity(clip.activity),
  });
  const matched = new Float32Array(frames);
  for (let i = 0; i < frames; i++) matched[i] = (path[i + pad] as number) - pad;
  return matched;
}

/** How reliable each guide frame's match is: high where both voices sound (the clip's frame is the matched one). */
function reliability(guide: FrameFeatures, clip: FrameFeatures, matched: Float32Array): Float32Array {
  const weight = new Float32Array(matched.length);
  for (let i = 0; i < weight.length; i++) {
    weight[i] = SILENT_WEIGHT + (1 - SILENT_WEIGHT) * (guide.activity[i] as number) * clipSoundAt(clip, matched[i] as number);
  }
  return weight;
}

/** How much the clip sounds at (fractional) frame j: 0 outside the clip. */
function clipSoundAt(clip: FrameFeatures, j: number): number {
  const at = Math.round(j);
  return at < 0 || at >= clip.frames ? 0 : (clip.activity[at] as number);
}

/** How much the clip sounds at each output frame (the frame it plays there). */
function soundOf(clip: FrameFeatures, matched: Float32Array): Float32Array {
  return matched.map((j) => clipSoundAt(clip, j));
}

/** Median and largest |move| and the time moved, over the audible part. */
export function lagStats(lag: Float32Array, hopSec: number, audible: AudibleSpan): Omit<AlignStats, 'overlapSec'> {
  const from = Math.max(0, Math.floor(audible.fromSec / hopSec));
  const to = Math.min(lag.length - 1, Math.ceil(audible.toSec / hopSec));
  const moves: number[] = [];
  let moved = 0;
  for (let i = from; i <= to; i++) {
    const move = Math.abs(lag[i] as number);
    moves.push(move);
    if (move > MOVED_SEC) moved += hopSec;
  }
  moves.sort((a, b) => a - b);
  return {
    medianMoveMs: moves.length ? (moves[moves.length >> 1] as number) * 1000 : 0,
    maxMoveMs: moves.length ? (moves[moves.length - 1] as number) * 1000 : 0,
    movedSec: moved,
  };
}

/** A progress reporter that maps a step's 0..1 into its share of the whole. */
function stepProgress(onProgress: AlignInput['onProgress'], from: number, share: number) {
  return onProgress ? (fraction: number) => onProgress(from + share * fraction) : undefined;
}

/** Aligns the clip to the guide: see the file header. */
export function alignToGuide(input: AlignInput): AlignOutput {
  const { channels, sampleRate, audible, guide, onProgress } = input;
  const length = channels[0]?.length ?? 0;
  const frames = frameCount(length, sampleRate);
  const overlapSec = overlapOf(audible, guide.audible);
  const identity = (): AlignOutput => ({
    channels: channels.map((c) => Float32Array.from(c)),
    lagSec: new Float32Array(frames),
    hopSec: ALIGN_HOP_SEC,
    kept: [],
    stats: { medianMoveMs: 0, maxMoveMs: 0, movedSec: 0, overlapSec },
  });
  if (length === 0 || overlapSec < ALIGN_HOP_SEC * 4) return identity();

  const clipMono = monoMix(channels);
  const clipFeatures = frameFeatures({ mono: clipMono, sampleRate, frames, audible });
  onProgress?.(FEATURES_SHARE / 2);
  const guideFeatures = frameFeatures({ mono: guide.mono, sampleRate: guide.sampleRate, frames, audible: guide.audible });
  onProgress?.(FEATURES_SHARE);

  const settings = tightnessSettings(input.tightness);
  const halfBand = Math.max(2, Math.round((input.maxShiftSec ?? MAX_ALIGN_SHIFT_SEC) / ALIGN_HOP_SEC));
  const matched = matchVoices(guideFeatures, clipFeatures, frames, {
    halfBand,
    stepPenalty: settings.stepPenalty,
    ...(onProgress ? { onProgress: stepProgress(onProgress, FEATURES_SHARE, MATCH_SHARE) as (f: number) => void } : {}),
  });
  const attacks = syllableOnsets(clipFeatures, clipMono, sampleRate).map((sec) => ({ sec }));
  const shaped = shapeLag(
    lagFromPath(matched, ALIGN_HOP_SEC),
    reliability(guideFeatures, clipFeatures, matched),
    matched,
    attacks,
    input.tightness,
    audible,
    ALIGN_HOP_SEC,
    soundOf(clipFeatures, matched),
  );
  onProgress?.(FEATURES_SHARE + MATCH_SHARE);
  let aligned = renderLag(channels, sampleRate, shaped.lag, ALIGN_HOP_SEC, shaped.kept);
  onProgress?.(FEATURES_SHARE + MATCH_SHARE + RENDER_SHARE);

  const stats: AlignStats = { ...lagStats(shaped.lag, ALIGN_HOP_SEC, audible), overlapSec };
  if (input.pitch > 0) {
    const followed = followGuidePitch(
      aligned,
      sampleRate,
      guideFeatures.f0,
      input.pitch / 100,
      stepProgress(onProgress, FEATURES_SHARE + MATCH_SHARE + RENDER_SHARE, 1 - FEATURES_SHARE - MATCH_SHARE - RENDER_SHARE),
    );
    aligned = followed.channels;
    stats.pitchCentsBefore = followed.stats.medianCentsBefore;
    stats.pitchCentsAfter = followed.stats.medianCentsAfter;
  }
  onProgress?.(1);
  return { channels: aligned, lagSec: shaped.lag, hopSec: ALIGN_HOP_SEC, kept: shaped.kept, stats };
}
