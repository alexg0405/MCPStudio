/**
 * Which blocks of a long song a deck keeps in memory, pure (no DOM, no audio). The song is cut into blocks of 2^16
 * frames; the deck holds a window of them around the play position (a minute and a half ahead, half a minute behind: the
 * playhead may jump back, and a slow scratch or a loop reaches behind), plus the places it may jump to without notice
 * (the cue point, the hot cues, the loop), and loads them most urgent first: what is about to be heard, then the pins,
 * then the rest of the window ahead, then behind. `engine/deck/deck-stream.ts` does the loading.
 */

export interface BlockPins {
  /** Blocks (inclusive range) that stay loaded while pinned: a cue point's first seconds, a loop. */
  first: number;
  last: number;
}

export interface WindowInput {
  /** Blocks in the song. */
  blocks: number;
  /** The block under the play position. */
  playBlock: number;
  /** Which way the song is heard going: 1 forward (the usual), −1 backward (a scratch or reverse). */
  direction?: 1 | -1;
  /** Blocks wanted behind and ahead of the play block (ahead is the side it is heading to). */
  behind: number;
  ahead: number;
  pins?: readonly BlockPins[];
  /** Slots in the pool: at most this many blocks are wanted. */
  capacity: number;
}

/** Blocks right at the play position that are loaded before anything else (the next ~4 s). */
export const URGENT_AHEAD = 3;
export const URGENT_BEHIND = 1;

/**
 * The blocks to hold, most urgent first, never more than `capacity`. Pins that don't fit beside the urgent blocks are
 * dropped, farthest first (and the far end of the window goes before any pin does).
 */
export function planWindow(w: WindowInput): number[] {
  const { blocks, capacity } = w;
  if (blocks <= 0 || capacity <= 0) return [];
  const dir = w.direction === -1 ? -1 : 1;
  const pb = Math.max(0, Math.min(blocks - 1, w.playBlock));
  const seen = new Set<number>();
  const order: number[] = [];
  const add = (b: number) => {
    if (b < 0 || b >= blocks || seen.has(b)) return;
    seen.add(b);
    order.push(b);
  };
  // Tier 0: what is about to be heard (and the block just passed).
  for (let k = 0; k <= URGENT_AHEAD; k++) add(pb + dir * k);
  for (let k = 1; k <= URGENT_BEHIND; k++) add(pb - dir * k);
  // Tier 1: the pins, nearest first.
  const pinned: number[] = [];
  for (const p of w.pins ?? []) for (let b = Math.max(0, p.first); b <= Math.min(blocks - 1, p.last); b++) pinned.push(b);
  pinned.sort((a, b) => Math.abs(a - pb) - Math.abs(b - pb) || a - b);
  for (const b of pinned) add(b);
  // Tier 2: the rest ahead; tier 3: behind. Over capacity the end of the order goes first: the far window, then the farthest pins.
  for (let k = URGENT_AHEAD + 1; k <= w.ahead; k++) add(pb + dir * k);
  for (let k = URGENT_BEHIND + 1; k <= w.behind; k++) add(pb - dir * k);
  return order.length <= capacity ? order : order.slice(0, capacity);
}

/** The block range a stretch of frames covers (inclusive), or null when it is empty or off the song. */
export function blockRange(startFrame: number, endFrame: number, blockFrames: number, blocks: number): BlockPins | null {
  if (!(endFrame > startFrame) || blocks <= 0) return null;
  const first = Math.max(0, Math.floor(startFrame / blockFrames));
  const last = Math.min(blocks - 1, Math.floor((endFrame - 1) / blockFrames));
  return last < first ? null : { first, last };
}

/** Pool slots a deck needs for a window of `windowSec` plus its pins, at a sample rate and block size. */
export function poolSlots(opts: { sampleRate: number; blockFrames: number; behindSec: number; aheadSec: number; pinSlots: number; spare?: number }): {
  behind: number;
  ahead: number;
  slots: number;
} {
  const behind = Math.ceil((opts.behindSec * opts.sampleRate) / opts.blockFrames) + 1;
  const ahead = Math.ceil((opts.aheadSec * opts.sampleRate) / opts.blockFrames) + 1;
  return { behind, ahead, slots: behind + ahead + 1 + opts.pinSlots + (opts.spare ?? 6) };
}
