/** Where a clip sits on the playlist canvas: shared by drawing and hit testing. */
import type { Clip } from '@core/model/types';
import type { Viewport } from '../../timeline/viewport';

/** Height of a clip's title bar (px). */
export const CLIP_TITLE_HEIGHT = 13;

/** Corner radius of clips (px). */
export const CLIP_RADIUS = 4;

/** The ▾ clip-menu button at a clip's top-left corner: its size (px). */
export const CLIP_MENU_SIZE = 12;

/** Clips narrower than this (px) have no ▾ button. */
export const CLIP_MENU_MIN_WIDTH = 30;

/** A clip's rectangle on the canvas, in CSS pixels. */
export interface ClipBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The body under the title bar (notes, waveform, automation curve). */
  bodyY: number;
  bodyH: number;
}

/**
 * The box of a clip on track row `row`. The edges sit on whole device pixels, so a clip's edge is where the grid line
 * of the same tick is, whatever the zoom or the pixel ratio.
 */
export function clipBox(vp: Viewport, row: number, c: Pick<Clip, 'start' | 'length'>): ClipBox {
  const y = vp.snap(vp.rowToY(row) + 1);
  const h = vp.snap(vp.rowToY(row) + vp.rowHeight - 1) - y;
  const x = vp.tickToPx(c.start);
  const w = Math.max(3, vp.tickToPx(c.start + c.length) - x - 1);
  return { x, y, w, h, bodyY: y + CLIP_TITLE_HEIGHT + 1, bodyH: h - CLIP_TITLE_HEIGHT - 3 };
}
