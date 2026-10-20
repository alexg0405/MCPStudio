/**
 * A selection that does not depend on colour: a heavy outline and a filled triangle in the top-left corner. Canvas
 * editors draw it on a selected chord or word when colour-blind safe colours are on (`theme.colorSafe`).
 */

/** Width of the heavy outline (px) and the side of the corner triangle (px). */
const OUTLINE_WIDTH = 2.5;
const CORNER_SIZE = 7;

/** Draws the mark inside the box (x, y, w, h) in `color`; nothing is left changed on the context. */
export function drawSelectionMark(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = OUTLINE_WIDTH;
  const inset = OUTLINE_WIDTH / 2;
  ctx.strokeRect(x + inset, y + inset, Math.max(1, w - OUTLINE_WIDTH), Math.max(1, h - OUTLINE_WIDTH));
  if (w > CORNER_SIZE * 2 && h > CORNER_SIZE * 2) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + CORNER_SIZE, y);
    ctx.lineTo(x, y + CORNER_SIZE);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
