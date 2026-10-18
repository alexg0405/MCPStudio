/**
 * Putting notes on the grid: the draw tool (a click draws a note, or a chord with a chord stamp, and a drag moves it into
 * place), the paint tool (fills cells along the pointer's path) and the outline of the chord a click would draw.
 */
import { noteName } from '@agstudio/sdk/notes';
import type { Note } from '@core/model/types';
import { addNotes } from '@core/ops/notes';
import { snapFloor } from '@core/time/snap';
import { stampKeys, stampName } from '../stamp';
import { auditionKey } from './audition';
import type { EditTarget, PianoRollContext, WritableTarget } from './context';
import { showHint } from './cursor';
import type { CreateDrag, PaintDrag } from './drag';
import { drawKeyAtY, notesToDraw } from './hit-test';
import { snapTicksFor } from './target';

/** Paint tool: a stamped note is at most this many grid steps long, whatever length new notes remember. */
const MAX_PAINT_STEPS = 4;

/**
 * A press on empty space with the draw or paint tool. Paint starts filling at once; draw creates a note (or a chord) at
 * the pointer and lets the drag move it into place.
 */
export function startDrawing(ctx: PianoRollContext, x: number, y: number, event: PointerEvent, target: EditTarget): void {
  const editor = ctx.s.editor.getState();
  const grid = snapTicksFor(ctx, target, event);
  const key = drawKeyAtY(ctx, y, target);
  if (editor.pianoRoll.tool === 'paint') {
    const gesture = ctx.s.history.gesture('Paint notes');
    const drag: PaintDrag = { kind: 'paint', gesture, done: new Set(), lastTick: snapFloor(ctx.vp.xToTick(x), grid), key };
    ctx.state.drag = drag;
    paintAt(ctx, drag, x, y, target, event);
    auditionKey(ctx, key);
    return;
  }
  editor.selectNotes([]);
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), grid));
  const notes = notesToDraw(ctx, tick, key, editor.pianoRoll.lastLength, target);
  ctx.state.drag = { kind: 'create', notes, grabOffset: ctx.vp.xToTick(x) - tick };
  ctx.state.previewAdds = notes;
  auditionKey(ctx, key);
  ctx.invalidate('notes', 'lane');
}

/** The new note (or chord) follows the pointer, on the grid and the keys. */
export function moveCreate(ctx: PianoRollContext, drag: CreateDrag, x: number, y: number, event: PointerEvent, target: EditTarget): void {
  const grid = snapTicksFor(ctx, target, event);
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x) - drag.grabOffset + grid / 2, grid));
  const key = drawKeyAtY(ctx, y, target);
  const first = drag.notes[0] as Note;
  if (tick === first.tick && key === first.key) return;
  drag.notes = notesToDraw(ctx, tick, key, first.length, target);
  ctx.state.previewAdds = drag.notes;
  auditionKey(ctx, key);
  ctx.invalidate('notes', 'lane');
}

/** Releasing a created note: it is added (one undo step) and selected. */
export function commitCreate(ctx: PianoRollContext, drag: CreateDrag, target: WritableTarget): void {
  const { patternId, channelId } = target;
  const notes = drag.notes;
  ctx.s.history.transact(notes.length > 1 ? 'Add chord' : 'Add note', (draft) => addNotes(draft, patternId, channelId, notes));
  ctx.s.editor.getState().selectNotes(notes.map((note) => note.id));
}

/** Paint tool: fills every free cell between the last stamp and the pointer (fast drags skip cells). */
export function paintAt(
  ctx: PianoRollContext,
  drag: PaintDrag,
  x: number,
  y: number,
  target: EditTarget,
  event: { altKey: boolean },
): void {
  const { patternId, channelId } = target;
  if (!patternId || !channelId) return;
  const grid = snapTicksFor(ctx, target, event);
  const lastLength = ctx.s.editor.getState().pianoRoll.lastLength;
  const length = Math.max(grid, Math.min(lastLength, grid * MAX_PAINT_STEPS));
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), grid));
  const key = drawKeyAtY(ctx, y, target);
  const from = Math.min(drag.lastTick, tick);
  const to = Math.max(drag.lastTick, tick);
  drag.lastTick = tick;
  const added: Note[] = [];
  for (let cellTick = from; cellTick <= to; cellTick += length) {
    const cell = `${cellTick}:${key}`;
    if (drag.done.has(cell)) continue;
    drag.done.add(cell);
    for (const note of notesToDraw(ctx, cellTick, key, length, target)) {
      const isTaken = target.notes.some((existing) => existing.key === note.key && existing.tick === cellTick);
      if (!isTaken) added.push(note);
    }
  }
  if (added.length === 0) return;
  drag.gesture.update((draft) => addNotes(draft, patternId, channelId, added));
  if (key !== ctx.state.audition?.key) auditionKey(ctx, key);
}

/** Updates the chord-stamp outline under the pointer (draw and paint tools with a chord chosen). */
export function updateStampHover(ctx: PianoRollContext, x: number, y: number, target: EditTarget, event: { altKey: boolean }): void {
  const { state } = ctx;
  const settings = ctx.s.editor.getState().pianoRoll;
  const isStamping = !!settings.chord && (settings.tool === 'draw' || settings.tool === 'paint') && !!target.channelId && !state.hover;
  if (!isStamping) {
    if (state.stampHover) {
      state.stampHover = null;
      ctx.invalidate('overlay');
    }
    return;
  }
  const grid = snapTicksFor(ctx, target, event);
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), grid));
  const keys = stampKeys(drawKeyAtY(ctx, y, target), settings.chord, settings.inversion, target.songKey);
  const previous = state.stampHover;
  const isSame = previous && previous.tick === tick && previous.keys.length === keys.length && previous.keys.every((key, i) => key === keys[i]);
  if (isSame) return;
  const name = stampName(keys);
  const length = settings.tool === 'paint' ? Math.max(grid, Math.min(settings.lastLength, grid * MAX_PAINT_STEPS)) : settings.lastLength;
  state.stampHover = { tick, length, keys, name };
  showHint(ctx, `Click to draw ${name || 'the chord'}: ${keys.map(noteName).join(' ')}`);
  ctx.invalidate('overlay');
}
