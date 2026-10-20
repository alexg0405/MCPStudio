import { useEffect, useRef } from 'react';
import { thumbnailRects, type Thumbnail } from '@core/versions/thumbnail';

/** Drawn height of a project card's picture, in CSS pixels (its width is the card's). */
export const THUMBNAIL_HEIGHT = 60;
/** The width used before the card has been measured (and where nothing can be measured). */
const FALLBACK_WIDTH = 216;

/** Marks fade a little so the picture reads as a picture, not as a control. */
const MARK_ALPHA = 0.85;

/** Paints the picture into the canvas at `width` CSS pixels, in the theme's colours. */
function paint(canvas: HTMLCanvasElement, thumbnail: Thumbnail | null, width: number): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(THUMBNAIL_HEIGHT * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const css = getComputedStyle(canvas);
  context.fillStyle = css.getPropertyValue('--ag-surface-inset').trim() || '#0e0f11';
  context.fillRect(0, 0, width, THUMBNAIL_HEIGHT);
  if (!thumbnail) return;
  const accent = css.getPropertyValue('--ag-accent').trim() || '#c9a45c';
  context.globalAlpha = MARK_ALPHA;
  for (const rect of thumbnailRects(thumbnail, width, THUMBNAIL_HEIGHT)) {
    context.fillStyle = rect.color ?? accent;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  context.globalAlpha = 1;
}

/**
 * The small picture of a project's arrangement: one row per playlist track, a mark where clips play. The geometry is
 * `thumbnailRects` (whole pixels, the same every time); this only paints it, as wide as its card.
 */
export function ProjectThumbnail({ thumbnail, label }: { thumbnail: Thumbnail | null; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const widthRef = useRef(FALLBACK_WIDTH);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      widthRef.current = Math.round(canvas.getBoundingClientRect().width) || widthRef.current;
      paint(canvas, thumbnail, widthRef.current);
    };
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [thumbnail]);
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={thumbnail && thumbnail.rows.length > 0 ? `Arrangement of ${label}` : `${label} has nothing on its playlist yet`}
      style={{ display: 'block', width: '100%', height: THUMBNAIL_HEIGHT }}
    />
  );
}
