/**
 * The grid's pointer events. Right-click erases notes (FL) with every tool but Select; with the Select tool, with Ctrl/Cmd
 * held, or on an empty spot without dragging, it opens the context menu instead.
 *
 * This file decides which tool a press belongs to and passes moves and releases on to the module of the drag in progress
 * (`note-drag`, `draw-tools`, `note-tools`); each of those keeps the details of its own drag.
 */
import { snapRound } from '@core/time/snap';
import { stopAudition } from './audition';
import { asWritable, type EditTarget, type PianoRollContext, type WritableTarget } from './context';
import { updateCursor } from './cursor';
import type { Drag } from './drag';
import { commitCreate, moveCreate, paintAt, startDrawing, updateStampHover } from './draw-tools';
import { hitTest, localPoint } from './hit-test';
import { openMenu } from './menu';
import { commitMove, commitResize, moveNotes, resizeNotes, startNoteDrag } from './note-drag';
import {
  moveErase,
  moveMarquee,
  muteAt,
  sliceNoteAt,
  startErase,
  startMarquee,
  startMute,
} from './note-tools';
import { editTarget, snapTicksFor } from './target';
import { panBy, scrollWhileDragging } from './viewport-control';

/** A press on the grid. */
export function onPointerDown(ctx: PianoRollContext, event: PointerEvent): void {
  const target = editTarget(ctx);
  const host = ctx.els.gridHost;
  const { x, y } = localPoint(ctx, event);
  if (event.button === 1) {
    event.preventDefault();
    host.setPointerCapture(event.pointerId);
    ctx.state.drag = { kind: 'pan', x: event.clientX, y: event.clientY };
    updateCursor(ctx);
    return;
  }
  const writable = asWritable(target);
  if (!writable) return;
  event.preventDefault();
  ctx.s.view.getState().focusWindow('piano-roll');
  ctx.state.stampHover = null;
  const editor = ctx.s.editor.getState();
  const tool = editor.pianoRoll.tool;
  const hit = hitTest(ctx, x, y, writable);
  const hasModifier = event.metaKey || event.ctrlKey;

  if (event.button === 2 && (tool === 'select' || hasModifier)) {
    openMenu(ctx, event, writable, hit);
    return;
  }
  host.setPointerCapture(event.pointerId);
  if (event.button === 2 || tool === 'delete') {
    startErase(ctx, event, x, y, writable);
    return;
  }
  if (event.button !== 0) return;
  if (tool === 'slice') {
    if (hit) sliceNoteAt(ctx, hit, x, event, writable);
    return;
  }
  if (tool === 'mute') {
    startMute(ctx, hit, x, y, writable);
    return;
  }
  if (hit && tool !== 'paint') {
    startNoteDrag(ctx, hit, x, y, event, writable);
    return;
  }
  if (tool === 'select' || (tool === 'draw' && hasModifier)) {
    startMarquee(ctx, x, y, hasModifier);
    return;
  }
  startDrawing(ctx, x, y, event, writable);
}

/** The pointer moved over the grid: hover when nothing is being dragged, else carry on the drag. */
export function onPointerMove(ctx: PianoRollContext, event: PointerEvent): void {
  const { state } = ctx;
  // The button was let go where no pointerup reached us (outside the window, another window took focus): this move is
  // the drop, so the drag does not carry on without a button.
  if (state.drag && event.buttons === 0) {
    onPointerUp(ctx, event);
    return;
  }
  const target = editTarget(ctx);
  const { x, y } = localPoint(ctx, event);
  const drag = state.drag;
  if (!drag) {
    hover(ctx, x, y, event, target);
    return;
  }
  scrollWhileDragging(ctx, x, y, target);
  switch (drag.kind) {
    case 'pan':
      panBy(ctx, drag, event, target);
      return;
    case 'move':
      moveNotes(ctx, drag, x, y, event, target);
      return;
    case 'resize':
      resizeNotes(ctx, drag, x, event, target);
      return;
    case 'create':
      moveCreate(ctx, drag, x, y, event, target);
      return;
    case 'marquee':
      moveMarquee(ctx, drag, x, y, target.notes);
      return;
    case 'paint':
      paintAt(ctx, drag, x, y, target, event);
      return;
    case 'erase':
      moveErase(ctx, drag, event, x, y, target);
      return;
    case 'mute':
      muteAt(ctx, drag, x, y, target);
      return;
    default:
      return;
  }
}

/** Nothing is being dragged: the note under the pointer lights up, and the chord stamp's outline follows it. */
function hover(ctx: PianoRollContext, x: number, y: number, event: PointerEvent, target: EditTarget): void {
  const { state } = ctx;
  const hit = hitTest(ctx, x, y, target);
  const isSliceTool = ctx.s.editor.getState().pianoRoll.tool === 'slice';
  if (hit?.note.id !== state.hover?.note.id || hit?.zone !== state.hover?.zone || isSliceTool) {
    state.hover = hit;
    state.sliceLineX = ctx.vp.tickToX(snapRound(ctx.vp.xToTick(x), snapTicksFor(ctx, target, event)));
    ctx.invalidate('overlay');
    updateCursor(ctx);
  }
  updateStampHover(ctx, x, y, target, event);
}

/** The button was let go: the drag is committed as one undo step. */
export function onPointerUp(ctx: PianoRollContext, event: PointerEvent): void {
  const { state } = ctx;
  const drag = state.drag;
  if (!drag) return;
  ctx.els.gridHost.releasePointerCapture(event.pointerId);
  const target = editTarget(ctx);
  state.drag = null;
  stopAudition(ctx);
  const writable = asWritable(target);
  if (writable) commitDrag(ctx, drag, event, writable);
  state.preview = null;
  state.previewAdds = [];
  updateCursor(ctx);
  ctx.invalidate('notes', 'lane', 'overlay');
}

/** Writes what the drag did into the pattern (one undo step), according to the kind of drag. */
function commitDrag(ctx: PianoRollContext, drag: Drag, event: PointerEvent, target: WritableTarget): void {
  switch (drag.kind) {
    case 'move':
      commitMove(ctx, drag, target);
      return;
    case 'resize':
      commitResize(ctx, drag, target);
      return;
    case 'create':
      commitCreate(ctx, drag, target);
      return;
    case 'paint':
    case 'mute':
      drag.gesture.commit();
      return;
    case 'erase':
      drag.gesture.commit();
      // A right-click on an empty spot that erased nothing opens the menu.
      if (event.button === 2 && !drag.moved && drag.done.size === 0) openMenu(ctx, event, target, null);
      return;
    default:
      return;
  }
}

/** Esc or a cancelled pointer: the drag is dropped and the pattern stays as it was. */
export function cancelDrag(ctx: PianoRollContext): void {
  const { state } = ctx;
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  if (drag.kind === 'paint' || drag.kind === 'erase' || drag.kind === 'mute' || drag.kind === 'lane') drag.gesture.cancel();
  if (drag.kind === 'lane') ctx.els.laneValue.textContent = '';
  state.preview = null;
  state.previewAdds = [];
  stopAudition(ctx);
  ctx.invalidate('notes', 'lane', 'overlay');
}

/** The pointer left the grid: nothing is under it any more. */
export function onPointerLeave(ctx: PianoRollContext): void {
  const { state } = ctx;
  if (state.drag || (!state.hover && !state.stampHover)) return;
  state.hover = null;
  state.stampHover = null;
  ctx.invalidate('overlay');
}
