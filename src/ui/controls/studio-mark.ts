/**
 * The Studio mark (the AI studio's symbol): a ring with a sound wave running through it. One drawing
 * for the DOM (`Icon name="studio"`, `studioMarkSvg()` for imperative elements) and for canvases
 * (`drawStudioMark()`), in a 16×16 box, stroked in the current color.
 */
export const STUDIO_RING = 'M14.3 8a6.3 6.3 0 1 1-12.6 0a6.3 6.3 0 1 1 12.6 0';
export const STUDIO_WAVE = 'M3.4 8.1c.8 0 1.1-2.6 2-2.6s1.3 5.1 2.3 5.1 1.4-6.2 2.4-6.2 1.2 3.7 2.1 3.7h.4';

/** The mark as an inline SVG string (for elements a controller fills in). */
export function studioMarkSvg(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${STUDIO_RING}" opacity="0.55"/><path d="${STUDIO_WAVE}"/></svg>`;
}

let ring: Path2D | null = null;
let wave: Path2D | null = null;

/** Draws the mark centered at x, y, `size` px wide, with the context's current strokeStyle. */
export function drawStudioMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ring ??= new Path2D(STUDIO_RING);
  wave ??= new Path2D(STUDIO_WAVE);
  const k = size / 16;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.55;
  ctx.stroke(ring);
  ctx.globalAlpha = alpha;
  ctx.stroke(wave);
  ctx.restore();
}
