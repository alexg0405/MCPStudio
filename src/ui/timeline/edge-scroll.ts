/** Scrolling by dragging past the edge of the grid (a note or clip carried to the edge pulls the view along). */
import type { Viewport } from './viewport';

/** The pointer is "at the edge" this close to it (px). */
const EDGE_ZONE = 24;

/** How fast the view scrolls: pixels per pixel the pointer is inside the edge zone, for each direction. */
export interface EdgeScrollSpeed {
  sideways: number;
  vertical: number;
}

/**
 * Scrolls the view when the pointer (`x`, `y` in the grid) is in an edge zone. Returns true when it scrolled, so the
 * caller redraws and saves the view. The left edge only counts once the view is scrolled off the start of the song.
 */
export function scrollAtEdges(vp: Viewport, x: number, y: number, maxTick: number, speed: EdgeScrollSpeed): boolean {
  let dx = 0;
  let dy = 0;
  if (x > vp.width - EDGE_ZONE) dx = (x - (vp.width - EDGE_ZONE)) * speed.sideways;
  else if (x < EDGE_ZONE && vp.scrollTick > 0) dx = (x - EDGE_ZONE) * speed.sideways;
  if (y > vp.height - EDGE_ZONE) dy = (y - (vp.height - EDGE_ZONE)) * speed.vertical;
  else if (y < EDGE_ZONE) dy = (y - EDGE_ZONE) * speed.vertical;
  if (!dx && !dy) return false;
  vp.scrollBy(dx, dy, maxTick);
  return true;
}
