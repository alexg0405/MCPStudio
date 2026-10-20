/**
 * Dynamic time warping of a clip onto a guide, inside a band around the diagonal, so memory and time grow with the
 * clip's length times the band, never with its length squared (a 3-minute clip at 5 ms frames is 36,000 frames; the
 * band of half a second makes the table 36,000 × 201 bytes, not 1.3 billion cells).
 *
 * Both voices are on the same axis (frame i of the guide and frame i of the clip are the same moment when nothing
 * has to move), so the diagonal is "no change" and the band is the largest move. The steps keep the speed of the clip
 * within 1/4× to 4×: (1,1) advances both frames, (1,2) to (1,4) let the clip run 2× to 4× as fast for a moment, (2,1)
 * to (4,1) a half to a quarter as fast. A step that is not diagonal costs a small penalty (more for the steeper kinds)
 * where either voice sounds, so a held note keeps the offset it has instead of wandering and the path only bends
 * where the sound asks for it; where both are silent a step is free, so the path can use a gap to make up the time
 * between two syllables. The path may start and end at any offset inside the band.
 */
import { FEATURE_DIM } from './features';

/** Settings of the match: the band either side of the diagonal (frames) and what a non-diagonal step costs. */
export interface DtwOptions {
  /** Frames either side of the diagonal the path may reach. */
  halfBand: number;
  /** Added to the cost of every step that is not diagonal (doubled for a step of 3). */
  stepPenalty: number;
  /** 0..1 per frame, how much each voice sounds (absent: always): a step in silence between both is free. */
  guideActivity?: Float32Array;
  clipActivity?: Float32Array;
  /** Called now and then with 0..1. */
  onProgress?: (fraction: number) => void;
}

/** One kind of step: the guide advances `guide` frames while the clip advances `clip` frames. */
interface Move {
  guide: number;
  clip: number;
  /** Multiples of the step penalty this kind pays. */
  penalties: number;
}

/** The steps, in the order of their trace codes (0 = diagonal). */
const MOVES: readonly Move[] = [
  { guide: 1, clip: 1, penalties: 0 },
  { guide: 1, clip: 2, penalties: 1 },
  { guide: 2, clip: 1, penalties: 1 },
  { guide: 1, clip: 3, penalties: 2 },
  { guide: 3, clip: 1, penalties: 2 },
  { guide: 1, clip: 4, penalties: 3 },
  { guide: 4, clip: 1, penalties: 3 },
];
/** The most guide frames one step covers: how many earlier rows of cost and accumulated cost are kept. */
const MAX_GUIDE_ADVANCE = 4;
/** How often progress is reported, in rows. */
const PROGRESS_ROWS = 2000;

/** The memory the match needs for this many frames, in bytes (the trace table; the rows are small). */
export function dtwTableBytes(frames: number, halfBand: number): number {
  return frames * (2 * halfBand + 1);
}

/** Squared distance between guide frame i and clip frame j (Infinity outside the clip). */
function frameDistance(guide: Float32Array, clip: Float32Array, i: number, j: number, frames: number): number {
  if (j < 0 || j >= frames) return Infinity;
  let sum = 0;
  const a = i * FEATURE_DIM;
  const b = j * FEATURE_DIM;
  for (let d = 0; d < FEATURE_DIM; d++) {
    const diff = (guide[a + d] as number) - (clip[b + d] as number);
    sum += diff * diff;
  }
  return sum;
}

/** Costs of one row of the band: `row[k]` is the distance of guide frame i to clip frame i + k − halfBand. */
function fillRow(row: Float64Array, guide: Float32Array, clip: Float32Array, i: number, frames: number, halfBand: number) {
  for (let k = 0; k < row.length; k++) row[k] = frameDistance(guide, clip, i, i + k - halfBand, frames);
}

/** How much a step into cell (i, j) costs, as a share of the full penalty: 0 where both voices are silent. */
function activityAt(opts: DtwOptions, i: number, j: number): number {
  const guide = opts.guideActivity ? (opts.guideActivity[i] as number) : 1;
  const clip = opts.clipActivity ? ((opts.clipActivity[j] as number | undefined) ?? 0) : 1;
  return Math.max(guide, clip);
}

/** The accumulated cost of a cell reached from `move`, from the rows behind (`costs[n]` is the cost row n frames back). */
function cellCost(
  move: Move,
  k: number,
  accumulated: readonly Float64Array[],
  costs: readonly Float64Array[],
  penalty: number,
): number {
  const from = k + move.guide - move.clip;
  const before = accumulated[move.guide] as Float64Array;
  if (from < 0 || from >= before.length) return Infinity;
  let sum = before[from] as number;
  if (move.guide >= move.clip) {
    // The clip stood still while the guide advanced: every guide frame it covered is matched to the same clip frame.
    for (let n = 0; n < move.guide; n++) sum += (costs[n] as Float64Array)[k + n] as number;
  } else {
    // The clip ran ahead: its frames share the one guide frame, each counting for its share of it.
    const share = move.guide / move.clip;
    for (let n = 0; n < move.clip; n++) sum += share * ((costs[0] as Float64Array)[k - n] as number);
  }
  return sum + move.penalties * penalty;
}

/**
 * The clip frame that matches each guide frame: both vectors are `frames` long (`FEATURE_DIM` numbers per frame).
 * Returns, per guide frame, the clip frame (fractional: where a step skipped frames it is the middle of what the
 * step covered). The path starts at the first frame and ends at the last frame of the guide, at any offset.
 */
export function bandedDtw(guide: Float32Array, clip: Float32Array, frames: number, opts: DtwOptions): Float32Array {
  const { halfBand, stepPenalty } = opts;
  const width = 2 * halfBand + 1;
  if (frames < 2) return Float32Array.from({ length: frames }, (_, i) => i);
  const trace = new Uint8Array(frames * width);
  // accumulated[n] is the accumulated cost n rows back (0 = the row being made), costs[n] the distances n rows back.
  let accumulated: Float64Array[] = Array.from({ length: MAX_GUIDE_ADVANCE + 1 }, () => new Float64Array(width).fill(Infinity));
  let costs: Float64Array[] = Array.from({ length: MAX_GUIDE_ADVANCE }, () => new Float64Array(width).fill(Infinity));
  for (let i = 0; i < frames; i++) {
    const costRow = costs[MAX_GUIDE_ADVANCE - 1] as Float64Array;
    fillRow(costRow, guide, clip, i, frames, halfBand);
    costs = [costRow, ...costs.slice(0, MAX_GUIDE_ADVANCE - 1)];
    const row = accumulated[MAX_GUIDE_ADVANCE] as Float64Array;
    const rowsBack = accumulated.slice(0, MAX_GUIDE_ADVANCE);
    accumulated = [row, ...rowsBack];
    for (let k = 0; k < width; k++) {
      if (i === 0) {
        row[k] = costRow[k] as number;
        continue;
      }
      let best = Infinity;
      let from = 0;
      for (let m = 0; m < MOVES.length; m++) {
        const move = MOVES[m] as Move;
        if (i < move.guide) continue;
        const total = cellCost(move, k, accumulated, costs, stepPenalty * activityAt(opts, i, i + k - halfBand));
        if (total < best) {
          best = total;
          from = m;
        }
      }
      row[k] = best;
      trace[i * width + k] = from;
    }
    if (opts.onProgress && i % PROGRESS_ROWS === 0) opts.onProgress(i / frames);
  }
  return walkBack(trace, frames, halfBand, bestEnd(accumulated[0] as Float64Array));
}

/** The band position where the last row's accumulated cost is lowest (the first one on a tie). */
function bestEnd(lastRow: Float64Array): number {
  let best = 0;
  for (let k = 1; k < lastRow.length; k++) if ((lastRow[k] as number) < (lastRow[best] as number)) best = k;
  return best;
}

/** Follows the trace from the last frame (at band position `end`) back to the first and reads off the clip frame of every guide frame. */
function walkBack(trace: Uint8Array, frames: number, halfBand: number, end: number): Float32Array {
  const width = 2 * halfBand + 1;
  const matched = new Float32Array(frames);
  let i = frames - 1;
  let k = end;
  while (i >= 0) {
    const j = i + k - halfBand;
    const move = MOVES[i === 0 ? 0 : (trace[i * width + k] as number)] as Move;
    if (move.guide >= move.clip) {
      for (let n = 0; n < move.guide && i - n >= 0; n++) matched[i - n] = j;
    } else {
      matched[i] = j - (move.clip - 1) / 2;
    }
    i -= move.guide;
    k += move.guide - move.clip;
  }
  return matched;
}
