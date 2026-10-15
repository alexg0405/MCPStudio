/**
 * Which decoded buffers the engine keeps in memory (pure; sample-residency.ts applies it). Long
 * songs don't all fit: everything a clip overlapping the window around the playhead plays from is
 * pinned (must be in memory), and the clips after it are prefetched in the order playback reaches
 * them while they fit the budget. The rest may be evicted (least recently used first).
 */

/** A playlist audio clip in song seconds, and the cache keys it plays from. */
export interface ClipSpan {
  start: number;
  end: number;
  keys: readonly string[];
}

export interface ResidencyInput {
  clips: readonly ClipSpan[];
  /** Keys needed whatever the position (samples played by notes and previews). */
  always: readonly string[];
  /** The song second being heard, or where playback will start. */
  pos: number;
  /** The song loops from `end` back to `start` (seconds), or plays once. */
  loop: { start: number; end: number } | null;
  /** Seconds before and after `pos` whose clips are pinned. */
  behind: number;
  ahead: number;
  /** Estimated bytes of a key's buffer. */
  bytesOf(key: string): number;
  /** Bytes the plan may fill with pinned and prefetched buffers. */
  budget: number;
  /** Clips further than this (seconds of playback past the window) aren't prefetched (default: no limit). */
  prefetchWithin?: number;
}

export interface ResidencyPlan {
  /** Must be in memory (window clips and `always`). */
  pinned: string[];
  /** Wanted next, nearest first (within the budget). */
  prefetch: string[];
}

/** The window as one or two spans of song seconds (two when it wraps around the loop end). */
export function windowSpans(
  pos: number,
  behind: number,
  ahead: number,
  loop: { start: number; end: number } | null,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [[pos - behind, pos + ahead]];
  if (loop && loop.end > loop.start && pos < loop.end && pos + ahead > loop.end) {
    spans[0] = [pos - behind, loop.end];
    spans.push([loop.start, Math.min(loop.end, loop.start + (pos + ahead - loop.end))]);
  }
  return spans;
}

const overlaps = (c: ClipSpan, [a, b]: [number, number]) => c.end > a && c.start < b;

/** How far playback is from reaching a clip outside the window (behind ones count four times). */
function distance(c: ClipSpan, pos: number, ahead: number, loop: { start: number; end: number } | null): number {
  const edge = pos + ahead;
  if (c.start >= edge) return c.start - edge;
  if (loop && loop.end > loop.start && c.start >= loop.start && c.start < pos)
    return Math.max(0, loop.end - edge) + (c.start - loop.start);
  return 4 * Math.max(0, pos - c.end);
}

export function planResidency(input: ResidencyInput): ResidencyPlan {
  const spans = windowSpans(input.pos, input.behind, input.ahead, input.loop);
  const pinned = new Set<string>(input.always);
  const rest: ClipSpan[] = [];
  for (const c of input.clips) {
    if (spans.some((s) => overlaps(c, s))) for (const k of c.keys) pinned.add(k);
    else rest.push(c);
  }
  let used = 0;
  for (const k of pinned) used += input.bytesOf(k);
  const order = rest
    .map((c) => ({ c, d: distance(c, input.pos, input.ahead, input.loop) }))
    .sort((a, b) => a.d - b.d || a.c.start - b.c.start);
  const prefetch: string[] = [];
  const seen = new Set(pinned);
  const within = input.prefetchWithin ?? Infinity;
  for (const { c, d } of order) {
    if (d > within) break;
    const keys = c.keys.filter((k) => !seen.has(k));
    const bytes = keys.reduce((n, k) => n + input.bytesOf(k), 0);
    if (used + bytes > input.budget) break;
    used += bytes;
    for (const k of keys) {
      seen.add(k);
      prefetch.push(k);
    }
  }
  return { pinned: [...pinned], prefetch };
}
