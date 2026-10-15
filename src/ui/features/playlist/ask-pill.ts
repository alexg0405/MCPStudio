/**
 * The playlist's Ask AI pill: at the top-right of the selected clips (a compact "Studio mark" for a single
 * clip), else of the loop region. Pure placement; the controller moves the element on dirty frames.
 */

/** The part the pill belongs to, in grid pixels. */
export interface PillTarget {
  /** From the part's start to its end. */
  x0: number;
  x1: number;
  /** From the top of its first track to the bottom of its last (0 and 0 for the loop region). */
  y0: number;
  y1: number;
  /** A single clip: just the mark. */
  compact: boolean;
}

export const PILL_HEIGHT = 20;
/** Pill to part, and pill to the grid's edges. */
const GAP = 3;
const EDGE = 2;

/**
 * Where the pill goes in the grid (its top-left corner), or null when the part is scrolled out of
 * sight sideways. It sits just above the part's top-right corner, inside it when there is no room
 * above, and always inside the grid.
 */
export function askPillPlace(
  t: PillTarget,
  pill: { w: number; h: number },
  view: { w: number; h: number },
): { x: number; y: number } | null {
  if (t.x1 <= 0 || t.x0 >= view.w || view.w < pill.w + 2 * EDGE) return null;
  const x = Math.max(EDGE, Math.min(view.w - pill.w - EDGE, t.x1 - pill.w));
  let y = t.y0 - pill.h - GAP;
  if (y < EDGE) y = t.y0 + GAP;
  y = Math.max(EDGE, Math.min(view.h - pill.h - EDGE, y));
  return { x: Math.round(x), y: Math.round(y) };
}

/** The pill's text. */
export const pillText = (t: PillTarget): string => (t.compact ? '' : 'Ask Studio');
