import type { Tick } from '../model/types';

/**
 * Index of the first span that ends after `tick`, in a list sorted by start whose spans do not overlap (the chord track
 * and the lyrics: their ops keep it so). Everything before it is wholly to the left of `tick`, so a lane that draws
 * only what is on screen can start there instead of at the first span of the song. Binary search.
 */
export function firstEndingAfter(spans: readonly { tick: Tick; length: Tick }[], tick: Tick): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const span = spans[middle] as { tick: Tick; length: Tick };
    if (span.tick + span.length <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}
