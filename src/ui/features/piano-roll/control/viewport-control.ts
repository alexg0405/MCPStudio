/** Moving the view: zoom buttons, the wheel, the scrollbar, middle-button pan, dragging past the edge, centering on the notes. */
import { ticksPerBar } from '@core/time/ppq';
import { scrollAtEdges, type EdgeScrollSpeed } from '../../../timeline/edge-scroll';
import { startThumbDrag } from '../../../timeline/scrollbar';
import { clamp } from '../../../timeline/viewport';
import { applyWheel } from '../../../timeline/wheel';
import { rowForKey } from '../render';
import type { EditTarget, PianoRollContext } from './context';
import type { PanDrag } from './drag';
import { localPoint } from './hit-test';
import { editTarget, maxScrollTick } from './target';

/** Dragging past the grid's edge scrolls this fast (see `scrollAtEdges`). */
const EDGE_SCROLL_SPEED: EdgeScrollSpeed = { sideways: 0.6, vertical: 0.4 };
/** The number of keys, and the key a view with no notes is centered on (C5). */
const KEY_COUNT = 128;
const DEFAULT_CENTER_KEY = 72;
/** With no notes, a channel with a root key is centered half an octave above it. */
const ROOT_KEY_CENTER_OFFSET = 6;
const LOWEST_KEY = 0;
const HIGHEST_KEY = 127;

/** The size of the grid, the scrollbar or the event lane changed: measure them again (the frame loop never asks the layout). */
export function measureLayout(ctx: PianoRollContext): void {
  const { vp, els, state } = ctx;
  const rect = els.gridHost.getBoundingClientRect();
  vp.width = Math.max(1, Math.round(rect.width));
  vp.height = Math.max(1, Math.round(rect.height));
  state.scrollTrackWidth = els.hscroll.getBoundingClientRect().width;
  state.laneHeight = Math.max(1, Math.round(els.velocityHost.getBoundingClientRect().height));
  vp.clampScroll(maxScrollTick(ctx, editTarget(ctx)));
  ctx.invalidate('grid', 'notes', 'overlay', 'keys', 'ruler', 'lane');
}

/** The view scrolled or zoomed: redraw what depends on it and save it a moment later. */
export function viewportChanged(ctx: PianoRollContext): void {
  // Grid, notes, ruler and lane notice a scroll or zoom themselves (PannedLayer); the keys follow vertical scroll.
  ctx.invalidate('overlay', 'keys');
  ctx.viewportSaver.scheduleSave();
}

/** The toolbar's zoom buttons: zoom the time axis around the middle of the view. */
export function zoomBy(ctx: PianoRollContext, factor: number): void {
  const { vp } = ctx;
  vp.zoomX(factor, vp.width / 2);
  vp.clampScroll(maxScrollTick(ctx, editTarget(ctx)));
  ctx.follow.zoomed();
  viewportChanged(ctx);
}

/** The wheel over the grid, the keys, the ruler or the event lane. */
export function onWheel(ctx: PianoRollContext, event: WheelEvent): void {
  event.preventDefault();
  const outcome = applyWheel(ctx.vp, event, localPoint(ctx, event), maxScrollTick(ctx, editTarget(ctx)));
  // Zooming keeps following (it glides back to the playhead); scrolling by hand waits a moment (follow.ts).
  if (outcome === 'zoomed-time') ctx.follow.zoomed();
  else if (outcome === 'scrolled-sideways') ctx.follow.userScrolled();
  viewportChanged(ctx);
}

/** The scrollbar thumb was pressed: the view follows the pointer until release. */
export function onThumbDown(ctx: PianoRollContext, event: PointerEvent): void {
  startThumbDrag(event, {
    thumb: ctx.els.hthumb,
    track: ctx.els.hscroll,
    vp: ctx.vp,
    totalTicks: maxScrollTick(ctx, editTarget(ctx)),
    onScrolled: () => {
      ctx.follow.userScrolled();
      viewportChanged(ctx);
    },
  });
}

/** A middle-button drag: the view moves with the pointer. */
export function panBy(ctx: PianoRollContext, drag: PanDrag, event: PointerEvent, target: EditTarget): void {
  ctx.vp.scrollBy(drag.x - event.clientX, drag.y - event.clientY, maxScrollTick(ctx, target));
  drag.x = event.clientX;
  drag.y = event.clientY;
  ctx.follow.userScrolled();
  viewportChanged(ctx);
}

/** While a drag is going, carrying the pointer to the edge of the grid scrolls the view. */
export function scrollWhileDragging(ctx: PianoRollContext, x: number, y: number, target: EditTarget): void {
  const drag = ctx.state.drag;
  if (!drag || drag.kind === 'pan') return;
  if (scrollAtEdges(ctx.vp, x, y, maxScrollTick(ctx, target), EDGE_SCROLL_SPEED)) viewportChanged(ctx);
}

/** Centers the view on the channel's notes (or on the middle of the keyboard), and brings the first note into view. */
export function centerOnNotes(ctx: PianoRollContext, target: EditTarget): void {
  const { vp } = ctx;
  const visibleRows = vp.height / vp.rowHeight;
  let centerKey = DEFAULT_CENTER_KEY;
  if (target.notes.length > 0) {
    let lowest = HIGHEST_KEY;
    let highest = LOWEST_KEY;
    for (const note of target.notes) {
      lowest = Math.min(lowest, note.key);
      highest = Math.max(highest, note.key);
    }
    centerKey = (lowest + highest) / 2;
  } else if (target.rootKey !== null) {
    centerKey = target.rootKey + ROOT_KEY_CENTER_OFFSET;
  }
  vp.scrollRow = clamp(rowForKey(centerKey) - visibleRows / 2, 0, Math.max(0, KEY_COUNT - visibleRows));
  // Bring the first note into view if it's off-screen (or start at bar 1).
  const first = target.notes[0];
  const [firstVisibleTick, lastVisibleTick] = vp.visibleTicks();
  if (!first || first.tick < firstVisibleTick || first.tick > lastVisibleTick) {
    const bar = ticksPerBar(target.project.transport.timeSig);
    vp.scrollTick = first ? Math.max(0, Math.floor(first.tick / bar) * bar) : 0;
  }
  ctx.invalidate('grid', 'notes', 'overlay', 'keys', 'lane');
}
