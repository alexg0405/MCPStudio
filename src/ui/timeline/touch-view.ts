/** Two fingers on a timeline editor: the pan and pinch rules the playlist and the piano roll share (the touch twin of `wheel.ts`). */
import type { TwoFingerFrame } from '../touch/recognizer';
import type { Viewport } from './viewport';
import type { RowHeightRange, WheelOutcome } from './wheel';

/** A frame whose scale is within this of 1 does not zoom (no work for a pure pan). */
const NO_ZOOM_EPSILON = 1e-4;

/**
 * Applies what two fingers did to the view: the content follows the fingers (the view scrolls the other way), the time axis
 * zooms by the horizontal pinch and the rows by the vertical one, both keeping the point between the fingers still.
 * `left` and `top` are where the grid starts on the screen (client px). `rowHeights` limits the vertical zoom (the viewport's
 * own limits when left out). Returns what changed, as a wheel turn would, so the editor can tell the playhead follow.
 */
export function applyTwoFingers(
  vp: Viewport,
  frame: TwoFingerFrame,
  left: number,
  top: number,
  maxTick: number,
  rowHeights?: RowHeightRange,
): WheelOutcome {
  const isZoomingTime = Math.abs(frame.scaleX - 1) > NO_ZOOM_EPSILON;
  const isZoomingRows = Math.abs(frame.scaleY - 1) > NO_ZOOM_EPSILON;
  vp.scrollBy(-frame.panX, -frame.panY, maxTick);
  if (isZoomingTime) vp.zoomX(frame.scaleX, Math.max(0, frame.centerX - left));
  if (isZoomingRows) zoomRows(vp, frame.scaleY, Math.max(0, frame.centerY - top), rowHeights);
  vp.clampScroll(maxTick);
  if (isZoomingTime) return 'zoomed-time';
  if (Math.abs(frame.panX) >= 1) return 'scrolled-sideways';
  return 'changed-rows';
}

function zoomRows(vp: Viewport, factor: number, anchorY: number, range?: RowHeightRange): void {
  if (range) vp.zoomY(factor, anchorY, range.min, range.max);
  else vp.zoomY(factor, anchorY);
}
