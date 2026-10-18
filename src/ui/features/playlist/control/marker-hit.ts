/** Finding marker flags under the pointer. The ruler's picture slides under the view, so boxes are shifted by its offset. */
import type { MarkerId } from '@core/model/types';
import { MARKER_LANE_Y } from '../layout';
import { markerAtX, type MarkerBox } from '../marker-flags';
import type { PlaylistContext } from './context';

/** Markers live in the lower part of the ruler; a pointer this far (px) above the lane still counts. */
const MARKER_LANE_HIT_SLOP = 2;

/** A marker flag moved sideways (the ruler's picture is drawn wider than the view and slid). */
function shiftedBox(box: MarkerBox, dx: number): MarkerBox {
  if (dx === 0) return box;
  const ask = box.ask ? { ask: { x0: box.ask.x0 + dx, x1: box.ask.x1 + dx } } : {};
  return { ...box, x0: box.x0 + dx, x1: box.x1 + dx, ...ask };
}

/** The marker flag at (`x`, `y`) of the ruler (view pixels), or null. */
export function markerHit(ctx: PlaylistContext, x: number, y: number): MarkerBox | null {
  if (y < MARKER_LANE_Y - MARKER_LANE_HIT_SLOP) return null;
  const offset = ctx.layers.ruler.offset();
  const hit = markerAtX(ctx.state.markerBoxes, x - offset);
  return hit ? shiftedBox(hit, offset) : null;
}

/** A marker's flag as last drawn, in view coordinates (the ruler's picture slides under the view). */
export function markerBoxInView(ctx: PlaylistContext, id: MarkerId): MarkerBox | null {
  const box = ctx.state.markerBoxes.find((candidate) => candidate.id === id);
  return box ? shiftedBox(box, ctx.layers.ruler.offset()) : null;
}

/** Whether ruler x is on a flag's Studio mark (the "ask Studio about this section" button). */
export function isOnAskMark(box: MarkerBox | null, x: number): boolean {
  return !!box?.ask && x >= box.ask.x0 && x < box.ask.x1;
}
