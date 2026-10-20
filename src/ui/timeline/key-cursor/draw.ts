/**
 * Draws the keyboard cursor on an editor's overlay canvas: a dashed box around the cell or note it is on, with solid
 * ticks at the four corners. Shape carries the meaning (a dashed box with corners), so it does not depend on colour alone,
 * and the line is at least two pixels wide. A dark halo under it keeps it readable over any note or clip colour.
 */
import { alpha, type TimelineTheme } from '../canvas';

/** A rectangle on the canvas (CSS px). */
export interface CursorBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Width of the cursor's lines (px). WCAG asks for at least 2. */
export const CURSOR_LINE_PX = 2;
/** Length of a corner tick along each edge (px), and how far the box sticks out past what it surrounds. */
const CORNER_TICK_PX = 7;
const OUTSET_PX = 2;
/** The dash and gap of the box's edges (px). */
const DASH: number[] = [5, 3];
const NO_DASH: number[] = [];

/** Smallest box drawn (px): a cell squeezed to a sliver still shows a cursor. */
const MIN_SIZE_PX = 10;

/** The box the cursor is drawn in for a cell or note of `box`: a little bigger than it, never tiny. */
function cursorFrame(box: CursorBox): CursorBox {
  const w = Math.max(MIN_SIZE_PX, box.w + OUTSET_PX * 2);
  const h = Math.max(MIN_SIZE_PX, box.h + OUTSET_PX * 2);
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
}

function cornerTicks(canvas: CanvasRenderingContext2D, frame: CursorBox): void {
  const { x, y, w, h } = frame;
  const tick = Math.min(CORNER_TICK_PX, w / 2, h / 2);
  canvas.beginPath();
  canvas.moveTo(x, y + tick);
  canvas.lineTo(x, y);
  canvas.lineTo(x + tick, y);
  canvas.moveTo(x + w - tick, y);
  canvas.lineTo(x + w, y);
  canvas.lineTo(x + w, y + tick);
  canvas.moveTo(x + w, y + h - tick);
  canvas.lineTo(x + w, y + h);
  canvas.lineTo(x + w - tick, y + h);
  canvas.moveTo(x + tick, y + h);
  canvas.lineTo(x, y + h);
  canvas.lineTo(x, y + h - tick);
  canvas.stroke();
}

/** Draws the cursor around `box` (the cell or note it is on). */
export function drawKeyCursor(canvas: CanvasRenderingContext2D, theme: TimelineTheme, box: CursorBox): void {
  const frame = cursorFrame(box);
  // One pixel in, so a 2 px line is centred on the frame's edge and is not cut by the canvas edge.
  const edge = { x: frame.x + 1, y: frame.y + 1, w: frame.w - 2, h: frame.h - 2 };
  canvas.save();
  canvas.lineJoin = 'miter';
  canvas.lineWidth = CURSOR_LINE_PX + 2;
  canvas.strokeStyle = alpha(theme.glass, 0.85);
  canvas.setLineDash(NO_DASH);
  canvas.strokeRect(edge.x, edge.y, edge.w, edge.h);
  canvas.lineWidth = CURSOR_LINE_PX;
  canvas.strokeStyle = theme.cursor;
  canvas.setLineDash(DASH);
  canvas.strokeRect(edge.x, edge.y, edge.w, edge.h);
  canvas.setLineDash(NO_DASH);
  canvas.lineWidth = CURSOR_LINE_PX + 1;
  cornerTicks(canvas, edge);
  canvas.restore();
}
