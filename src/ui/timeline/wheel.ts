/** The mouse wheel and trackpad on a timeline editor: the zoom and scroll rules the editors share. */
import type { Viewport } from './viewport';

/** A wheel "line" is this many pixels (browsers report some wheels in lines, not pixels). */
const WHEEL_LINE_PX = 16;
/** Time zooms by e^(0.01) per wheel pixel, which is a comfortable pinch on a trackpad. */
const TIME_ZOOM_PER_PX = 0.01;
/** The height of rows zooms more gently: there are few of them. */
const ROW_ZOOM_PER_PX = 0.005;

/** What a wheel turn did, so the editor can tell the playhead follow about it. */
export type WheelOutcome =
  /** Zoomed the time axis: following goes on (the view glides back to the playhead). */
  | 'zoomed-time'
  /** Scrolled sideways by hand: following waits until the playhead is in view again. */
  | 'scrolled-sideways'
  /** Changed the rows only (zoom or vertical scroll): following is not affected. */
  | 'changed-rows';

/** How tall rows may get with Alt + wheel (px). */
export interface RowHeightRange {
  min: number;
  max: number;
}

/**
 * Applies one wheel event to the view: Ctrl/Cmd (a trackpad pinch arrives like this) zooms time around the pointer,
 * Alt changes the row height, Shift turns the vertical wheel sideways, anything else scrolls both ways. `at` is the
 * pointer in the grid's own pixels; `rowHeights` limits Alt + wheel (the viewport's own limits when left out).
 */
export function applyWheel(
  vp: Viewport,
  event: WheelEvent,
  at: { x: number; y: number },
  maxTick: number,
  rowHeights?: RowHeightRange,
): WheelOutcome {
  const pixelsPerUnit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? vp.height : 1;
  const dx = event.deltaX * pixelsPerUnit;
  const dy = event.deltaY * pixelsPerUnit;
  const isZoom = event.ctrlKey || event.metaKey;
  if (isZoom) vp.zoomX(Math.exp(-dy * TIME_ZOOM_PER_PX), Math.max(0, at.x));
  else if (event.altKey) zoomRows(vp, Math.exp(-dy * ROW_ZOOM_PER_PX), Math.max(0, at.y), rowHeights);
  else if (event.shiftKey) vp.scrollBy(dy || dx, 0, maxTick);
  else vp.scrollBy(dx, dy, maxTick);
  vp.clampScroll(maxTick);
  if (isZoom) return 'zoomed-time';
  if (Math.abs(dx) >= 1 || event.shiftKey) return 'scrolled-sideways';
  return 'changed-rows';
}

function zoomRows(vp: Viewport, factor: number, anchorY: number, range?: RowHeightRange): void {
  if (range) vp.zoomY(factor, anchorY, range.min, range.max);
  else vp.zoomY(factor, anchorY);
}
