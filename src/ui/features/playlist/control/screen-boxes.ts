/** Where parts of the playlist are on screen, for the Ask AI card to sit next to (client pixels; null when out of sight). */
import type { MarkerId, Tick } from '@core/model/types';
import { MARKER_LANE_Y, RULER_HEIGHT } from '../layout';
import type { ClientBox, PlaylistContext } from './context';
import { markerBoxInView } from './marker-hit';

/** The Ask AI pill on screen (null while it is hidden). */
export function pillBox(ctx: PlaylistContext): ClientBox | null {
  const pill = ctx.els.askPill;
  if (pill.style.display === 'none') return null;
  const rect = pill.getBoundingClientRect();
  return rect.width > 0 ? rect : null;
}

/** A marker's flag on screen (null when it is scrolled away or the playlist is hidden). */
export function markerBox(ctx: PlaylistContext, id: MarkerId): ClientBox | null {
  const box = markerBoxInView(ctx, id);
  const ruler = ctx.els.ruler.getBoundingClientRect();
  if (!box || ruler.width === 0) return null;
  const x0 = Math.max(0, box.x0);
  const x1 = Math.min(ctx.vp.width, box.x1);
  if (x1 <= x0) return null;
  return { left: ruler.left + x0, top: ruler.top + MARKER_LANE_Y, right: ruler.left + x1, bottom: ruler.top + RULER_HEIGHT };
}

/** A span of the song on the ruler (null when it is scrolled away or the playlist is hidden). */
export function spanBox(ctx: PlaylistContext, from: Tick, to: Tick): ClientBox | null {
  const ruler = ctx.els.ruler.getBoundingClientRect();
  const x0 = Math.max(0, ctx.vp.tickToX(from));
  const x1 = Math.min(ctx.vp.width, ctx.vp.tickToX(to));
  if (ruler.width === 0 || x1 <= x0) return null;
  return { left: ruler.left + x0, top: ruler.top, right: ruler.left + x1, bottom: ruler.bottom };
}
