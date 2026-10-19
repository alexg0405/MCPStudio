/**
 * Following the song through the lyrics, like karaoke: which word is being sung at a tick, and how far into it. A binary
 * search over the words in time order that fills the cursor it is given, so a frame loop can ask on every frame without
 * allocating.
 */
import type { LyricWord, Tick } from '../model/types';

/** Where the song is in the lyrics. */
export interface LyricCursor {
  /** Index in the word list of the last word that has begun (-1 before the first). */
  word: number;
  /** 0–1: how far through that word's length the tick is (1 once it is over, until the next word begins). */
  progress: number;
}

/** A cursor to pass to `lyricCursor` (make it once, reuse it). */
export const newCursor = (): LyricCursor => ({ word: -1, progress: 0 });

/** Fills `into` with the word being sung at `tick` (the last one that has begun) and how far through it the tick is. */
export function lyricCursor(sorted: readonly LyricWord[], tick: Tick, into: LyricCursor): LyricCursor {
  let low = 0;
  let high = sorted.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as LyricWord).tick <= tick) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  into.word = found;
  const word = sorted[found];
  into.progress = word ? Math.max(0, Math.min(1, (tick - word.tick) / word.length)) : 0;
  return into;
}
