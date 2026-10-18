/**
 * The grid's pointer events. This file only decides which tool a press belongs to and passes moves and releases on to
 * the module of the drag in progress (`clip-drag`, `pattern-draw`, `cut-tools`, `marquee`, `comp-swipe`, `audio-handles`,
 * `automation-edit`); each of those keeps the details of its own drag.
 */
import { pointerClip } from '@app/actions/comp';
import { snapRound } from '@core/time/snap';
import { setClipDropOver } from '../../../clip-drop';
import { audioHandleAt, commitLevelDrag, dragLevel, startLevelDrag, updateAudioHover } from './audio-handles';
import {
  automationTargetAt,
  dragAutomationPoint,
  dragAutomationTension,
  pressOnAutomation,
  updateAutomationHover,
} from './automation-edit';
import {
  commitMove,
  commitResize,
  dropOnOtherWindow,
  handOffToDropTarget,
  moveClips,
  resizeClips,
  startClipDrag,
} from './clip-drag';
import { commitCompSwipe, isCompSwipeStart, moveCompSwipe, startCompSwipe } from './comp-swipe';
import type { PlaylistContext } from './context';
import { updateCursor } from './cursor';
import type { Drag } from './drag';
import { eraseAt, sliceClip, startErase } from './cut-tools';
import { hitTest, isOnClipMenuButton, localPoint } from './hit-test';
import { currentProject, snapTicks } from './lanes';
import { moveMarquee, startMarquee } from './marquee';
import { commitCreate, moveCreate, paintAt, startPatternDraw, turnPressIntoCreate } from './pattern-draw';
import { panBy, scrollWhileDragging } from './viewport-control';

/** A press on the grid. */
export function onPointerDown(ctx: PlaylistContext, event: PointerEvent): void {
  const project = currentProject(ctx);
  const host = ctx.els.gridHost;
  const { x, y } = localPoint(ctx, event);
  if (event.button === 1) {
    event.preventDefault();
    host.setPointerCapture(event.pointerId);
    ctx.state.drag = { kind: 'pan', x: event.clientX, y: event.clientY };
    updateCursor(ctx);
    return;
  }
  event.preventDefault();
  host.setPointerCapture(event.pointerId);
  ctx.s.view.getState().focusWindow('playlist');
  const editor = ctx.s.editor.getState();
  const tool = editor.playlist.tool;
  const hit = hitTest(ctx, x, y, project);
  const hasModifier = event.metaKey || event.ctrlKey;

  if (event.button === 0 && hit && isOnClipMenuButton(ctx, hit.clip, x, y, project)) {
    host.releasePointerCapture(event.pointerId);
    // A clip that is part of the selection keeps it (its menu can act on all of them).
    if (!editor.clipSelection.includes(hit.clip.id)) editor.selectClips([hit.clip.id]);
    ctx.hooks.onClipMenu?.(hit.clip, event);
    return;
  }
  // Automation clips: points and curve handles are edited in place.
  if (pressOnAutomation(ctx, automationTargetAt(ctx, hit, x, y, project), x, y, event, project)) return;
  if (event.button === 2 || tool === 'delete') {
    startErase(ctx, x, y, project);
    return;
  }
  if (event.button !== 0) return;

  if (tool === 'slice') {
    if (hit) sliceClip(ctx, hit, x, event, project);
    return;
  }
  // Comp tool (or Alt) on a take: swipe across it to use that part.
  if (isCompSwipeStart(hit, tool, event)) {
    startCompSwipe(ctx, hit.clip, x, project);
    return;
  }
  // Audio clips: the gain and fade handles along the top of the body.
  const handle = hit && !hasModifier ? audioHandleAt(ctx, hit, x, y, project) : null;
  if (hit?.clip.kind === 'audio' && handle) {
    editor.selectClips([hit.clip.id]);
    startLevelDrag(ctx, hit.clip, handle, x, y);
    updateCursor(ctx);
    ctx.invalidate('clips');
    return;
  }
  if (hit && tool !== 'paint') {
    startClipDrag(ctx, hit, x, y, event, project);
    return;
  }
  if (tool === 'select' || (tool === 'draw' && hasModifier)) {
    startMarquee(ctx, x, y, hasModifier);
    return;
  }
  startPatternDraw(ctx, x, y, event, project);
}

/** The pointer moved over the grid: hover when nothing is being dragged, else carry on the drag. */
export function onPointerMove(ctx: PlaylistContext, event: PointerEvent): void {
  const { state } = ctx;
  // The button was let go where no pointerup reached us (outside the window, another window took focus): this move is
  // the drop, so the drag does not carry on without a button.
  if (state.drag && event.buttons === 0 && state.drag.kind !== 'marker' && state.drag.kind !== 'loop') {
    onPointerUp(ctx, event);
    return;
  }
  const project = currentProject(ctx);
  const { x, y } = localPoint(ctx, event);
  const drag = state.drag;
  if (!drag) {
    hover(ctx, x, y, event);
    return;
  }
  if (drag.kind === 'move' && handOffToDropTarget(ctx, drag, event)) return;
  scrollWhileDragging(ctx, x, y, project);
  switch (drag.kind) {
    case 'comp':
      moveCompSwipe(ctx, drag, x, project);
      return;
    case 'level':
      dragLevel(ctx, drag, x, y, event);
      return;
    case 'point':
      dragAutomationPoint(ctx, drag, x, y, event);
      return;
    case 'tension':
      dragAutomationTension(ctx, drag, x, y);
      return;
    case 'pan':
      panBy(ctx, drag, event, project);
      return;
    case 'move':
      moveClips(ctx, drag, x, y, event, project);
      return;
    case 'resize':
      resizeClips(ctx, drag, x, event, project);
      return;
    case 'press':
      // Once the press has moved far enough it is a drag that places a clip, and this same move is its first move.
      if (turnPressIntoCreate(ctx, drag, x, y, project)) onPointerMove(ctx, event);
      return;
    case 'create':
      moveCreate(ctx, drag, x, y, project, event);
      return;
    case 'marquee':
      moveMarquee(ctx, drag, x, y, project);
      return;
    case 'paint':
      paintAt(ctx, drag, x, project, event);
      return;
    case 'erase':
      eraseAt(ctx, drag, x, y, project);
      return;
    default:
      return;
  }
}

/** Nothing is being dragged: what is under the pointer lights up, and the hint bar and cursor say what a drag would do. */
function hover(ctx: PlaylistContext, x: number, y: number, event: PointerEvent): void {
  const { state } = ctx;
  const project = currentProject(ctx);
  const hit = hitTest(ctx, x, y, project);
  const isSliceTool = ctx.s.editor.getState().playlist.tool === 'slice';
  pointerClip.id = hit?.clip.id ?? null;
  if (hit?.clip.id !== state.hover?.clip.id || hit?.zone !== state.hover?.zone || isSliceTool) {
    state.hover = hit;
    state.sliceLineX = hit ? ctx.vp.tickToX(snapRound(ctx.vp.xToTick(x), snapTicks(ctx, project, event))) : -1;
    ctx.invalidate('overlay');
    updateCursor(ctx);
  }
  updateAutomationHover(ctx, hit, x, y, project);
  updateAudioHover(ctx, hit, x, y, project);
}

/** The button was let go: the drag is committed as one undo step (or handed to another window). */
export function onPointerUp(ctx: PlaylistContext, event: PointerEvent): void {
  const { state } = ctx;
  const drag = state.drag;
  if (!drag) return;
  ctx.els.gridHost.releasePointerCapture(event.pointerId);
  state.drag = null;
  // Where the button was let go decides (the last move may have been somewhere else).
  if (drag.kind === 'move') handOffToDropTarget(ctx, drag, event);
  if (drag.kind === 'move' && drag.over) {
    state.preview = null;
    updateCursor(ctx);
    ctx.invalidate('clips', 'overlay');
    dropOnOtherWindow(drag, drag.over);
    return;
  }
  commitDrag(ctx, drag, event);
  state.preview = null;
  updateCursor(ctx);
  ctx.invalidate('clips', 'overlay');
}

/** Writes what the drag did into the project (one undo step), according to the kind of drag. */
function commitDrag(ctx: PlaylistContext, drag: Drag, event: PointerEvent): void {
  switch (drag.kind) {
    case 'move':
      commitMove(ctx, drag);
      return;
    case 'resize':
      commitResize(ctx, drag);
      return;
    case 'press':
      // A click (the pointer never went far) on an empty cell opens its menu.
      if (!drag.moved && event.type === 'pointerup') ctx.hooks.onEmptyMenu?.(drag.tick, drag.lane, event);
      return;
    case 'create':
      commitCreate(ctx, drag);
      return;
    case 'paint':
    case 'erase':
    case 'point':
    case 'tension':
      drag.gesture.commit();
      return;
    case 'comp':
      commitCompSwipe(ctx, drag);
      return;
    case 'level':
      commitLevelDrag(ctx, drag);
      return;
    default:
      return;
  }
}

/** Esc or a cancelled pointer: the drag is dropped and the project stays as it was. */
export function cancelDrag(ctx: PlaylistContext): void {
  const { state } = ctx;
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  if (drag.kind === 'marker') {
    state.markerDrag = null;
    ctx.invalidate('ruler', 'grid');
  }
  if (drag.kind === 'paint' || drag.kind === 'erase' || drag.kind === 'point' || drag.kind === 'tension') drag.gesture.cancel();
  if (drag.kind === 'move' && drag.over) setClipDropOver(null);
  state.preview = null;
  updateCursor(ctx);
  ctx.invalidate('clips', 'overlay');
}

/** The pointer left the grid: nothing is under it any more. */
export function onPointerLeave(ctx: PlaylistContext): void {
  const { state } = ctx;
  pointerClip.id = null;
  if (!state.drag && state.hover) {
    state.hover = null;
    ctx.invalidate('overlay');
  }
  if (!state.drag && state.autoHover) {
    state.autoHover = null;
    state.lastHint = null;
    ctx.invalidate('clips');
  }
}
