/** The rubber band drawn while dragging a box over a timeline editor to select what it touches. */
import type { TimelineTheme } from './canvas';
import type { Viewport } from './viewport';

/** The two corners of the box, in the grid's pixels, in the order the pointer made them (either may be the larger). */
export interface BoxCorners {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Draws the box as a tinted fill with a one-pixel outline, its edges on whole device pixels. */
export function drawSelectionBox(ctx: CanvasRenderingContext2D, vp: Viewport, theme: TimelineTheme, box: BoxCorners): void {
  const left = vp.snap(Math.min(box.x0, box.x1));
  const top = vp.snap(Math.min(box.y0, box.y1));
  const right = vp.snap(Math.max(box.x0, box.x1));
  const bottom = vp.snap(Math.max(box.y0, box.y1));
  ctx.fillStyle = theme.selectTint;
  ctx.strokeStyle = theme.select;
  ctx.fillRect(left, top, right - left, bottom - top);
  ctx.strokeRect(left + 0.5, top + 0.5, right - left, bottom - top);
}
