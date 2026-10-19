/** Moving the view: zoom buttons, the wheel, the scrollbar, middle-button pan, dragging past the edge, revealing a span. */
import type { Project, Tick } from '@core/model/types';
import { scrollAtEdges, type EdgeScrollSpeed } from '../../../timeline/edge-scroll';
import { startThumbDrag } from '../../../timeline/scrollbar';
import { clamp } from '../../../timeline/viewport';
import { applyTwoFingers } from '../../../timeline/touch-view';
import { applyWheel, type RowHeightRange } from '../../../timeline/wheel';
import type { TwoFingerFrame } from '../../../touch/recognizer';
import type { PlaylistContext } from './context';
import type { PanDrag } from './drag';
import { currentProject, maxScrollTick, shownLaneOrder } from './lanes';
import { localPoint } from './hit-test';

/** Alt + wheel makes tracks this tall at the smallest and the largest (px). */
const TRACK_HEIGHTS: RowHeightRange = { min: 18, max: 120 };
/** Dragging past the grid's edge scrolls this fast (see `scrollAtEdges`). */
const EDGE_SCROLL_SPEED: EdgeScrollSpeed = { sideways: 0.8, vertical: 0.3 };

/**
 * Drags that never scroll the view at its edges: points stay inside their clip, and a press on an empty cell scrolls
 * only once it becomes a drag (a `create`).
 */
const DRAGS_THAT_STAY_PUT: ReadonlySet<string> = new Set(['pan', 'press', 'point', 'tension', 'level']);

/** When revealing a span, the view is scrolled so it starts this fraction of the view's width in from the left edge. */
const REVEAL_LEAD_FRACTION = 0.1;
/** A span that begins in view counts as shown when this fraction of the view's width of it is in view. */
const REVEAL_SHOWN_FRACTION = 0.5;

/** The size of the grid or the scrollbar changed: measure them again (the frame loop never asks the layout for them). */
export function measureLayout(ctx: PlaylistContext): void {
  const { vp, els } = ctx;
  const rect = els.gridHost.getBoundingClientRect();
  vp.width = Math.max(1, Math.round(rect.width));
  vp.height = Math.max(1, Math.round(rect.height));
  ctx.state.scrollTrackWidth = els.hscroll.getBoundingClientRect().width;
  const project = currentProject(ctx);
  vp.rows = shownLaneOrder(ctx, project).length;
  vp.clampScroll(maxScrollTick(project));
  ctx.invalidate('grid', 'clips', 'overlay', 'headers', 'ruler');
}

/** The view scrolled or zoomed by itself or by the user: redraw what depends on it and save it a moment later. */
export function viewportChanged(ctx: PlaylistContext): void {
  const { vp, state } = ctx;
  // Grid, clips and ruler notice a scroll or zoom themselves (PannedLayer). The track headers only show the tracks, so a
  // horizontal scroll or zoom leaves them as they are.
  ctx.invalidate('overlay');
  if (vp.scrollRow !== state.drawnHeaderRow || vp.rowHeight !== state.drawnHeaderRowHeight) ctx.invalidate('headers');
  ctx.viewportSaver.scheduleSave();
}

/** The toolbar's zoom buttons: zoom the time axis around the middle of the view. */
export function zoomBy(ctx: PlaylistContext, factor: number): void {
  const { vp } = ctx;
  vp.zoomX(factor, vp.width / 2);
  vp.clampScroll(maxScrollTick(currentProject(ctx)));
  ctx.follow.zoomed();
  viewportChanged(ctx);
}

/** The wheel over the grid, the ruler or the track headers. */
export function onWheel(ctx: PlaylistContext, event: WheelEvent): void {
  event.preventDefault();
  const outcome = applyWheel(ctx.vp, event, localPoint(ctx, event), maxScrollTick(currentProject(ctx)), TRACK_HEIGHTS);
  // Zooming keeps following (it glides back to the playhead); scrolling by hand waits a moment (follow.ts).
  if (outcome === 'zoomed-time') ctx.follow.zoomed();
  else if (outcome === 'scrolled-sideways') ctx.follow.userScrolled();
  viewportChanged(ctx);
}

/** Two fingers moved over the grid, the ruler or the headers: pan, and zoom time (horizontal pinch) and track height (vertical pinch). */
export function panAndZoom(ctx: PlaylistContext, frame: TwoFingerFrame): void {
  const rect = ctx.els.gridHost.getBoundingClientRect();
  const outcome = applyTwoFingers(ctx.vp, frame, rect.left, rect.top, maxScrollTick(currentProject(ctx)), TRACK_HEIGHTS);
  // The same follow rules as the wheel: zooming keeps following, a sideways scroll by hand makes it wait.
  if (outcome === 'zoomed-time') ctx.follow.zoomed();
  else if (outcome === 'scrolled-sideways') ctx.follow.userScrolled();
  viewportChanged(ctx);
}

/** The scrollbar thumb was pressed: the view follows the pointer until release. */
export function onThumbDown(ctx: PlaylistContext, event: PointerEvent): void {
  startThumbDrag(event, {
    thumb: ctx.els.hthumb,
    track: ctx.els.hscroll,
    vp: ctx.vp,
    totalTicks: maxScrollTick(currentProject(ctx)),
    onScrolled: () => {
      ctx.follow.userScrolled();
      viewportChanged(ctx);
    },
  });
}

/** A middle-button drag: the view moves with the pointer. */
export function panBy(ctx: PlaylistContext, drag: PanDrag, event: PointerEvent, project: Project): void {
  ctx.vp.scrollBy(drag.x - event.clientX, drag.y - event.clientY, maxScrollTick(project));
  drag.x = event.clientX;
  drag.y = event.clientY;
  ctx.follow.userScrolled();
  viewportChanged(ctx);
}

/** While a drag is going, carrying the pointer to the edge of the grid scrolls the view. */
export function scrollWhileDragging(ctx: PlaylistContext, x: number, y: number, project: Project): void {
  const drag = ctx.state.drag;
  if (!drag || DRAGS_THAT_STAY_PUT.has(drag.kind)) return;
  if (scrollAtEdges(ctx.vp, x, y, maxScrollTick(project), EDGE_SCROLL_SPEED)) viewportChanged(ctx);
}

/** Scrolls so the span starts on screen (a little in from the left edge); true when it scrolled or already showed it. */
export function revealSpan(ctx: PlaylistContext, from: Tick, to: Tick): boolean {
  const { vp } = ctx;
  if (ctx.els.ruler.getBoundingClientRect().width === 0) return false;
  const visibleTicks = vp.width / vp.pxPerTick;
  const left = vp.scrollTick;
  const isShown = from >= left && Math.min(to, from + visibleTicks * REVEAL_SHOWN_FRACTION) <= left + visibleTicks;
  if (isShown) return true;
  const total = maxScrollTick(currentProject(ctx));
  const lastScroll = Math.max(0, Math.max(total, to) - visibleTicks * (1 - REVEAL_LEAD_FRACTION));
  vp.scrollTick = clamp(from - visibleTicks * REVEAL_LEAD_FRACTION, 0, lastScroll);
  ctx.follow.userScrolled();
  viewportChanged(ctx);
  return true;
}
