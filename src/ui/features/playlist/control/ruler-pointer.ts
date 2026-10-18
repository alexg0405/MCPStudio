/**
 * The ruler's pointer handling: a drag sets the loop region (Alt: the punch range), a click sets the song position,
 * marker flags are clicked (jump), dragged (move) and double-clicked (rename), and their right-click menus open.
 */
import { describeMarker, jumpToMarker, moveMarkerTo } from '@app/actions/markers';
import { emitHint } from '@agstudio/sdk/ui';
import type { MarkerId, Project, Tick } from '@core/model/types';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { formatBST, ticksPerBar } from '@core/time/ppq';
import { snapRound } from '@core/time/snap';
import type { PlaylistContext } from './context';
import { localPoint } from './hit-test';
import { currentProject, snapTicks } from './lanes';
import { isOnAskMark, markerHit } from './marker-hit';
import { renameMarker } from './marker-rename';

/** A marker flag pressed and moved less than this (px) is a click, not a drag. */
const MARKER_CLICK_SLOP_PX = 3;
/** The loop and punch ranges snap to a quarter of a bar. */
const RANGE_SNAP_BARS = 0.25;

/** A tick on the ruler where a loop or punch range edge goes: nearest quarter bar, never before the start. */
function rangeTickAt(ctx: PlaylistContext, x: number, project: Project): Tick {
  return Math.max(0, snapRound(ctx.vp.xToTick(x), ticksPerBar(project.transport.timeSig) * RANGE_SNAP_BARS));
}

/** The hint bar text for the marker the pointer is on (or the ruler's own hint when it is on none). */
function markerHint(ctx: PlaylistContext, id: MarkerId | null, isOnAsk: boolean, project: Project): string {
  const marker = id ? project.playlist.markers[id] : undefined;
  if (!marker) return ctx.els.ruler.getAttribute('data-hint') ?? '';
  const section = isOnAsk && id ? songSections(project).find((candidate) => candidate.markerId === id) : undefined;
  if (section) {
    const span = barSpan(section.from, section.to, project.transport.timeSig);
    return `Ask Studio about this section (${marker.name}, ${span}): it loops and a box opens for your request`;
  }
  return `Marker ${describeMarker(ctx.s, marker)}: click to jump there, drag to move it, double-click to rename, right-click for more`;
}

/** Lights up the marker flag under the pointer (and its Studio mark), with its hint. */
export function setMarkerHot(ctx: PlaylistContext, id: MarkerId | null, isOnAsk = false): void {
  const { state, els } = ctx;
  if (id === state.markerHot && isOnAsk === state.markerAskHot) return;
  state.markerHot = id;
  state.markerAskHot = isOnAsk;
  ctx.invalidate('ruler');
  els.ruler.style.cursor = isOnAsk ? 'pointer' : '';
  emitHint(els.ruler, markerHint(ctx, id, isOnAsk, currentProject(ctx)));
}

/** A press on the ruler. */
export function onRulerDown(ctx: PlaylistContext, event: PointerEvent): void {
  const project = currentProject(ctx);
  const { x, y } = localPoint(ctx, event, ctx.els.ruler);
  const hit = markerHit(ctx, x, y);
  if (event.button === 2) {
    event.preventDefault();
    if (hit) ctx.hooks.onMarkerMenu?.(hit.id, event);
    else ctx.hooks.onRulerMenu?.(Math.max(0, snapRound(ctx.vp.xToTick(x), snapTicks(ctx, project, event))), event);
    return;
  }
  if (event.button !== 0) return;
  event.preventDefault();
  // The flag's Studio mark acts at once (like a clip's ▾): ask the AI about the section.
  if (hit && isOnAskMark(hit, x)) {
    ctx.hooks.onMarkerAsk?.(hit.id, event);
    return;
  }
  ctx.els.ruler.setPointerCapture(event.pointerId);
  if (hit) {
    ctx.state.drag = { kind: 'marker', id: hit.id, x0: x, grab: ctx.vp.xToTick(x) - hit.tick, tick: hit.tick, moved: false };
    return;
  }
  // Alt-drag sets the punch range (what audio recording keeps) instead of the loop.
  ctx.state.drag = { kind: 'loop', t0: rangeTickAt(ctx, x, project), moved: false, ...(event.altKey ? { punch: true } : {}) };
}

/** The pointer moved over the ruler: hover a marker, or carry on a marker or loop drag. */
export function onRulerMove(ctx: PlaylistContext, event: PointerEvent): void {
  const drag = ctx.state.drag;
  if (drag && event.buttons === 0 && (drag.kind === 'marker' || drag.kind === 'loop')) {
    onRulerUp(ctx, event);
    return;
  }
  if (!drag) {
    const { x, y } = localPoint(ctx, event, ctx.els.ruler);
    const hit = markerHit(ctx, x, y);
    setMarkerHot(ctx, hit?.id ?? null, isOnAskMark(hit, x));
    return;
  }
  const project = currentProject(ctx);
  const { x } = localPoint(ctx, event, ctx.els.ruler);
  if (drag.kind === 'marker') {
    if (!drag.moved && Math.abs(x - drag.x0) < MARKER_CLICK_SLOP_PX) return;
    drag.moved = true;
    // Snapped to the playlist grid (Alt: free).
    drag.tick = Math.max(0, snapRound(ctx.vp.xToTick(x) - drag.grab, snapTicks(ctx, project, event)));
    ctx.state.markerDrag = { id: drag.id, tick: drag.tick };
    const marker = project.playlist.markers[drag.id];
    if (marker) {
      emitHint(ctx.els.ruler, `Move ‘${marker.name}’ to ${formatBST(drag.tick, project.transport.timeSig)} · release to drop it`);
    }
    ctx.invalidate('ruler', 'grid');
    return;
  }
  if (drag.kind !== 'loop') return;
  const tick = rangeTickAt(ctx, x, project);
  if (tick === drag.t0 && !drag.moved) return;
  drag.moved = true;
  const range = { start: Math.min(drag.t0, tick), end: Math.max(drag.t0, tick) };
  if (drag.punch) ctx.s.view.getState().setPunch(range);
  else ctx.s.view.getState().setLoop(range);
}

/** The button was let go on the ruler (or the move found it already was). */
export function onRulerUp(ctx: PlaylistContext, event: PointerEvent): void {
  const drag = ctx.state.drag;
  if (drag?.kind === 'marker') {
    ctx.els.ruler.releasePointerCapture(event.pointerId);
    ctx.state.drag = null;
    ctx.state.markerDrag = null;
    // A click on a marker sets the song position there; a drag moves it (one undo step).
    if (drag.moved) moveMarkerTo(ctx.s, drag.id, drag.tick);
    else jumpToMarker(ctx.s, drag.id);
    ctx.invalidate('ruler', 'grid');
    return;
  }
  if (drag?.kind !== 'loop') return;
  ctx.els.ruler.releasePointerCapture(event.pointerId);
  ctx.state.drag = null;
  if (drag.moved || drag.punch) return;
  // A click sets the song position (playback continues from there when playing).
  const view = ctx.s.view.getState();
  view.setSongStart(drag.t0);
  if (view.mode !== 'song') view.setMode('song');
  if (ctx.s.engine.playing) ctx.s.engine.play(drag.t0);
}

/** A double-click on the ruler renames the marker under it, or clears the loop (Alt: the punch range). */
export function onRulerDouble(ctx: PlaylistContext, event: MouseEvent): void {
  const { x, y } = localPoint(ctx, event, ctx.els.ruler);
  const hit = markerHit(ctx, x, y);
  // A double-click on the Studio mark is two clicks on it, not a rename.
  if (hit && isOnAskMark(hit, x)) return;
  if (hit) renameMarker(ctx, hit.id);
  else if (event.altKey) ctx.s.view.getState().setPunch(null);
  else ctx.s.view.getState().setLoop(null);
}
