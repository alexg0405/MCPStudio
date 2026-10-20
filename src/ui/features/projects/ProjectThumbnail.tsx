import { useEffect, useRef } from 'react';
import { thumbnailRects, type Thumbnail } from '@core/versions/thumbnail';

/** Drawn size of a project card's picture, in CSS pixels. */
export const THUMBNAIL_WIDTH = 216;
export const THUMBNAIL_HEIGHT = 60;

/** Marks fade a little so the picture reads as a picture, not as a control. */
const MARK_ALPHA = 0.85;

/**
 * The small picture of a project's arrangement: one row per playlist track, a mark where clips play. The geometry is
 * `thumbnailRects` (whole pixels, the same every time); this only paints it, in the theme's colours.
 */
export function ProjectThumbnail({ thumbnail, label }: { thumbnail: Thumbnail | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(THUMBNAIL_WIDTH * scale);
    canvas.height = Math.round(THUMBNAIL_HEIGHT * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const css = getComputedStyle(canvas);
    context.fillStyle = css.getPropertyValue('--ag-surface-inset').trim() || '#0e0f11';
    context.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    if (!thumbnail) return;
    const accent = css.getPropertyValue('--ag-accent').trim() || '#c9a45c';
    context.globalAlpha = MARK_ALPHA;
    for (const rect of thumbnailRects(thumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)) {
      context.fillStyle = rect.color ?? accent;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    context.globalAlpha = 1;
  }, [thumbnail]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={thumbnail && thumbnail.rows.length > 0 ? `Arrangement of ${label}` : `${label} has nothing on its playlist yet`}
      style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, maxWidth: '100%' }}
    />
  );
}
