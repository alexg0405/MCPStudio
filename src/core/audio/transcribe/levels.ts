/**
 * Loudness helpers for turning heard sounds into notes: a block-by-block level curve of the recording, a note's level from
 * it, and the splitting of one pitched stretch into repeated notes where the level dips and comes back. Pure.
 */

/** Seconds per block of the level curve. */
export const LEVEL_BLOCK_SEC = 0.01;
/** Floor of the level curve (dB), so silence is a number. */
const SILENCE_DB = -120;

/** The level (RMS, dB) of each 10 ms block of a signal. */
export function levelCurveDb(mono: Float32Array, sampleRate: number): Float32Array {
  const block = Math.max(1, Math.round(LEVEL_BLOCK_SEC * sampleRate));
  const blocks = Math.ceil(mono.length / block);
  const out = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const from = b * block;
    const to = Math.min(mono.length, from + block);
    let sum = 0;
    for (let i = from; i < to; i++) sum += (mono[i] as number) * (mono[i] as number);
    out[b] = Math.max(SILENCE_DB, 10 * Math.log10(sum / Math.max(1, to - from) + 1e-12));
  }
  return out;
}

/** The block a time (seconds) falls in, kept inside the curve. */
export function blockAt(curve: Float32Array, sec: number): number {
  return Math.max(0, Math.min(curve.length - 1, Math.floor(sec / LEVEL_BLOCK_SEC)));
}

/** A share (0..1) of the way up a sorted copy of the values; NaN for none. */
export function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))] as number;
}

/** A note's level (dB): the upper part of its blocks, so a quiet start or tail does not drag it down. */
export function noteLevelDb(curve: Float32Array, fromSec: number, toSec: number): number {
  const first = blockAt(curve, fromSec);
  const last = Math.max(first, blockAt(curve, toSec));
  const values: number[] = [];
  for (let b = first; b <= last; b++) values.push(curve[b] as number);
  return percentile(values, 0.8);
}

/** A dip must go this far under the level before it, and the level must come back by as much, to be a new note (dB). */
export const DEFAULT_DIP_DB = 6;
/** A piece made by a split is at least this long (s). */
const MIN_PIECE_SEC = 0.06;

/**
 * Where inside [fromSec, toSec] the level dips by `dipDb` and rises again: a repeated note of the same pitch (the pitch
 * track sees one long note). The split goes at the bottom of the dip, where the new note starts rising. Pieces under 60 ms are not made.
 */
export function splitPointsAtDips(curve: Float32Array, fromSec: number, toSec: number, dipDb = DEFAULT_DIP_DB): number[] {
  const first = blockAt(curve, fromSec);
  const last = blockAt(curve, toSec);
  const minPiece = Math.round(MIN_PIECE_SEC / LEVEL_BLOCK_SEC);
  const points: number[] = [];
  let pieceStart = first;
  let peak = curve[first] as number;
  let valley = Infinity;
  let valleyAt = first;
  for (let b = first + 1; b <= last; b++) {
    const level = curve[b] as number;
    if (level > peak && valley === Infinity) peak = level;
    if (level < peak - dipDb && level < valley) {
      valley = level;
      valleyAt = b;
    }
    const rises = valley !== Infinity && level > valley + dipDb;
    if (rises && valleyAt - pieceStart >= minPiece && last - valleyAt >= minPiece) {
      points.push(valleyAt * LEVEL_BLOCK_SEC);
      pieceStart = valleyAt;
      peak = level;
      valley = Infinity;
    } else if (rises) {
      valley = Infinity;
      peak = Math.max(peak, level);
    }
  }
  return points;
}
