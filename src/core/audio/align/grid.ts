/**
 * "Tighten timing to the grid": moves the syllable starts of a vocal towards the nearest grid line, by a strength, with
 * the same warp render as alignment. Each onset that lies within `maxMoveSec` of a grid line is given a target
 * (onset + strength × distance); the lag curve is a line between those moves (and 0 away from them), then the
 * attacks are kept sharp and the speed is kept within bounds exactly as for alignment.
 */
import { monoMix } from '../pitch-edit/render';
import { ALIGN_HOP_SEC, frameFeatures } from './features';
import { frameCount, lagStats } from './align';
import { finishLag } from './lag';
import { syllableOnsets } from './onsets';
import type { AlignOutput, AudibleSpan } from './types';
import { renderLag } from './warp-render';

/** Targets closer together than this (seconds) would fold the sound over itself: the later one is dropped. */
const MIN_TARGET_GAP_SEC = 0.04;
/** Away from a move the lag returns to 0 over this long (seconds); a gap longer than twice this has a flat part at 0. */
const RETURN_SEC = 0.25;

/** What `tightenToGrid` needs. */
export interface GridInput {
  channels: readonly Float32Array[];
  sampleRate: number;
  /** The part of the stretch the clip plays. */
  audible: AudibleSpan;
  /** The grid line nearest to a time (seconds from the start of the stretch). */
  nearestGridSec: (sec: number) => number;
  /** 0..100: how far towards the grid each onset moves. */
  strength: number;
  /** Onsets further than this from a grid line are left alone (seconds). */
  maxMoveSec: number;
  onProgress?: (fraction: number) => void;
}

/** One planned move: the onset in the clip (`fromSec`) and where it should end up. */
export interface GridMove {
  fromSec: number;
  toSec: number;
}

/** The moves that tighten these onsets to the grid; onsets already within a hair of it, or too far, stay. */
export function planGridMoves(
  onsets: readonly number[],
  nearestGridSec: (sec: number) => number,
  strength: number,
  maxMoveSec: number,
): GridMove[] {
  const moves: GridMove[] = [];
  const k = Math.min(1, Math.max(0, strength / 100));
  for (const t of onsets) {
    const distance = nearestGridSec(t) - t;
    if (Math.abs(distance) > maxMoveSec || Math.abs(distance) * k < 0.0005) continue;
    const target = t + k * distance;
    const previous = moves[moves.length - 1];
    if (previous && target - previous.toSec < MIN_TARGET_GAP_SEC) continue;
    moves.push({ fromSec: t, toSec: target });
  }
  return moves;
}

/** The lag curve (per frame of the hop) that is a line through the moves and 0 away from them. */
export function lagThroughMoves(moves: readonly GridMove[], frames: number, hopSec: number): Float32Array {
  const points: { at: number; lag: number }[] = [];
  moves.forEach((m, i) => {
    const previous = moves[i - 1];
    const gap = previous ? m.toSec - previous.toSec : Infinity;
    if (gap > 2 * RETURN_SEC) {
      if (previous) points.push({ at: previous.toSec + RETURN_SEC, lag: 0 });
      points.push({ at: m.toSec - RETURN_SEC, lag: 0 });
    }
    points.push({ at: m.toSec, lag: m.fromSec - m.toSec });
  });
  const last = moves[moves.length - 1];
  if (last) points.push({ at: last.toSec + RETURN_SEC, lag: 0 });
  const lag = new Float32Array(frames);
  let p = 0;
  for (let i = 0; i < frames; i++) {
    const t = i * hopSec;
    while (p + 1 < points.length && (points[p + 1] as { at: number }).at <= t) p++;
    const a = points[p];
    const b = points[p + 1];
    if (!a) continue;
    if (!b || t <= a.at) lag[i] = t < a.at ? 0 : a.lag;
    else lag[i] = a.lag + ((b.lag - a.lag) * (t - a.at)) / (b.at - a.at);
  }
  return lag;
}

/** Tightens the clip's syllable onsets to the grid: see the file header. */
export function tightenToGrid(input: GridInput): AlignOutput {
  const { channels, sampleRate, audible } = input;
  const length = channels[0]?.length ?? 0;
  const frames = frameCount(length, sampleRate);
  if (length === 0) {
    return {
      channels: [],
      lagSec: new Float32Array(frames),
      hopSec: ALIGN_HOP_SEC,
      kept: [],
      stats: { medianMoveMs: 0, maxMoveMs: 0, movedSec: 0, overlapSec: 0 },
    };
  }
  const mono = monoMix(channels);
  const features = frameFeatures({ mono, sampleRate, frames, audible });
  input.onProgress?.(0.3);
  const onsets = syllableOnsets(features, mono, sampleRate).filter((t) => t >= audible.fromSec && t <= audible.toSec);
  const moves = planGridMoves(onsets, input.nearestGridSec, input.strength, input.maxMoveSec);
  const raw = lagThroughMoves(moves, frames, ALIGN_HOP_SEC);
  // The path the lag implies, for finding where each attack lands in the output.
  const matched = raw.map((lag, i) => i + lag / ALIGN_HOP_SEC);
  const attacks = onsets.map((sec) => ({ sec }));
  const shaped = finishLag(raw, matched, attacks, audible, ALIGN_HOP_SEC, features.activity, 0);
  input.onProgress?.(0.5);
  const aligned = renderLag(channels, sampleRate, shaped.lag, ALIGN_HOP_SEC, shaped.kept);
  input.onProgress?.(1);
  return {
    channels: aligned,
    lagSec: shaped.lag,
    hopSec: ALIGN_HOP_SEC,
    kept: shaped.kept,
    stats: { ...lagStats(shaped.lag, ALIGN_HOP_SEC, audible), overlapSec: 0 },
  };
}
