import { noteStats } from './note-stats';
import { PITCH_NOTE_THRESHOLDS as T, framesToCents, median, type PitchFrames, type PitchNote } from './shared';

/** A range of frames [from, to]. */
type FrameRange = [from: number, to: number];

/** The median filter over voiced frames looks this many frames each side. */
const SMOOTHING_FRAMES = 4;
/** A new level must hold at least this many frames to count (even for a short hop). */
const MIN_SETTLE_FRAMES = 4;
/** The new level must stay within this share of the split distance of its first frame. */
const SETTLE_SPREAD_SHARE = 0.8;
/** The note's running centre follows the pitch at this rate while it stays within the split distance. */
const CENTRE_FOLLOW = 0.08;
/** A glide began where the pitch first moved this share of the split distance from the old level. */
const GLIDE_START_SHARE = 0.5;
/** The most times short pieces are joined in one run. */
const MAX_JOINS = 64;
/** A sliver at the edge of a run this far (cents) from its neighbour is dropped rather than joined. */
const SLIVER_DISTANCE_CENTS = 250;

/** Median-filtered pitch (cents) of each voiced frame, over ±4 voiced frames. */
function smoothedCents(cents: Float64Array, voiced: number[]): Float64Array {
  const n = voiced.length;
  const sm = new Float64Array(n);
  const win: number[] = [];
  for (let k = 0; k < n; k++) {
    win.length = 0;
    for (let j = Math.max(0, k - SMOOTHING_FRAMES); j <= Math.min(n - 1, k + SMOOTHING_FRAMES); j++) {
      win.push(cents[voiced[j] as number] as number);
    }
    sm[k] = median(win);
  }
  return sm;
}

/**
 * Cuts the smoothed pitch where it leaves the note's running centre by 65 cents and settles on a new level for
 * 50 ms; each cut goes back to where the glide began. Returns frame ranges (indices into the voiced frames).
 */
function cutAtPitchChanges(sm: Float64Array, hop: number): FrameRange[] {
  const n = sm.length;
  const settle = Math.max(MIN_SETTLE_FRAMES, Math.round(T.settleSec / hop));
  const pieces: FrameRange[] = [];
  let start = 0;
  let ref = sm[0] as number;
  for (let k = 1; k < n; k++) {
    const dev = Math.abs((sm[k] as number) - ref);
    if (!(dev > T.splitCents)) {
      ref += ((sm[k] as number) - ref) * CENTRE_FOLLOW;
      continue;
    }
    const end = Math.min(n, k + settle);
    let stable = end - k >= Math.min(settle, MIN_SETTLE_FRAMES) && (end - k >= settle || end === n);
    for (let j = k; j < end && stable; j++) {
      if (Math.abs((sm[j] as number) - (sm[k] as number)) > SETTLE_SPREAD_SHARE * T.splitCents) stable = false;
    }
    if (!stable) continue;
    // Back to where the glide began: the first frame already moving away from the old level.
    let b = k;
    while (b - 1 > start && Math.abs((sm[b - 1] as number) - ref) > GLIDE_START_SHARE * T.splitCents) b--;
    pieces.push([start, b - 1]);
    start = b;
    ref = median(Array.from(sm.subarray(k, end)));
    k = end - 1;
  }
  pieces.push([start, n - 1]);
  return pieces;
}

/** The median smoothed pitch of a piece, or Infinity-distance for a missing one. */
function distanceToPiece(sm: Float64Array, piece: FrameRange | undefined, mid: number): number {
  return piece ? Math.abs(median(Array.from(sm.subarray(piece[0], piece[1] + 1))) - mid) : Infinity;
}

/** The index of the shortest piece under `minPiece` frames, or −1 (the first one wins a tie). */
function shortestPiece(pieces: readonly FrameRange[], minPiece: number): number {
  let shortest = -1;
  for (let p = 0; p < pieces.length; p++) {
    const [a, b] = pieces[p] as FrameRange;
    const [sa, sb] = (pieces[shortest] ?? [0, 0]) as FrameRange;
    if (b - a + 1 < minPiece && (shortest < 0 || b - a < sb - sa)) shortest = p;
  }
  return shortest;
}

/** Short pieces join the neighbour with the nearest pitch; a sliver at a run's edge far from its neighbour is dropped. */
function joinShortPieces(pieces: FrameRange[], sm: Float64Array, hop: number): void {
  const minPiece = Math.max(2, Math.round(T.minPieceSec / hop));
  for (let guard = 0; guard < MAX_JOINS && pieces.length > 1; guard++) {
    const shortest = shortestPiece(pieces, minPiece);
    if (shortest < 0) break;
    const [a, b] = pieces[shortest] as FrameRange;
    const mid = median(Array.from(sm.subarray(a, b + 1)));
    const prev = pieces[shortest - 1];
    const next = pieces[shortest + 1];
    const toPrev = distanceToPiece(sm, prev, mid);
    const toNext = distanceToPiece(sm, next, mid);
    // A sliver at the very start or end of a run that is far from its neighbour is not part of the
    // note (the tracker's last wild frames as a voice dies away): it is dropped.
    if ((!prev || !next) && Math.min(toPrev, toNext) > SLIVER_DISTANCE_CENTS) {
      pieces.splice(shortest, 1);
      continue;
    }
    if (toPrev <= toNext && prev) {
      prev[1] = b;
      pieces.splice(shortest, 1);
    } else if (next) {
      next[0] = a;
      pieces.splice(shortest, 1);
    } else break;
  }
}

/** Splits one run of voiced frames (indices into the track) at pitch changes. Returns [from, to] frame ranges. */
function splitRun(cents: Float64Array, voiced: number[], hop: number): FrameRange[] {
  if (voiced.length === 0) return [];
  const sm = smoothedCents(cents, voiced);
  const pieces = cutAtPitchChanges(sm, hop);
  joinShortPieces(pieces, sm, hop);
  return pieces.map(([a, b]) => [voiced[a] as number, voiced[b] as number]);
}

/** Voiced frames from `start`, joined across gaps shorter than `gapFrames`; returns them and where the run ended. */
function voicedRun(f0: Float32Array, start: number, gapFrames: number): { voiced: number[]; end: number } {
  const voiced: number[] = [];
  let gap = 0;
  let j = start;
  for (; j < f0.length; j++) {
    if ((f0[j] as number) > 0) {
      voiced.push(j);
      gap = 0;
    } else if (++gap >= gapFrames) break;
  }
  return { voiced, end: j };
}

/** Cuts a (cleaned) pitch track into notes. */
export function segmentNotes(frames: PitchFrames): PitchNote[] {
  const { f0, hop, t0 } = frames;
  const cents = framesToCents(f0);
  const gapFrames = Math.max(1, Math.round(T.gapSec / hop));
  const notes: PitchNote[] = [];
  const n = f0.length;
  let i = 0;
  while (i < n) {
    if (!((f0[i] as number) > 0)) {
      i++;
      continue;
    }
    const run = voicedRun(f0, i, gapFrames);
    for (const [a, b] of splitRun(cents, run.voiced, hop)) {
      let count = 0;
      for (let k = a; k <= b; k++) if ((f0[k] as number) > 0) count++;
      if (count * hop < T.minNoteSec) continue;
      notes.push({ from: t0 + (a - 0.5) * hop, to: t0 + (b + 0.5) * hop, ...noteStats(f0, cents, a, b, hop) });
    }
    i = run.end;
  }
  return notes;
}
