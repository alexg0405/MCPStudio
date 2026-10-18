/**
 * Moving and resizing notes with the pointer. While dragging, the notes are only previewed (`state.preview`); the pattern
 * changes once, as one undo step, when the button is let go. Shift copies instead of moving.
 */
import { newId } from '@core/model/ids';
import type { Note } from '@core/model/types';
import { addNotes, editNotes } from '@core/ops/notes';
import { snapRound } from '@core/time/snap';
import { auditionKey } from './audition';
import type { EditTarget, Hit, PianoRollContext, WritableTarget } from './context';
import type { MoveDrag, ResizeDrag } from './drag';
import { keyAtY } from './hit-test';
import { movedKeys } from '../stamp';
import { snapTicksFor } from './target';

/**
 * A press on a note with a note-editing tool: with Ctrl/Cmd it toggles the note in the selection, otherwise it selects
 * the note (keeping a selection it is part of) and starts moving it, or resizing it by its end.
 */
export function startNoteDrag(
  ctx: PianoRollContext,
  hit: Hit,
  x: number,
  y: number,
  event: PointerEvent,
  target: EditTarget,
): void {
  const editor = ctx.s.editor.getState();
  const selected = editor.noteSelection;
  const isInSelection = selected.includes(hit.note.id);
  if (event.metaKey || event.ctrlKey) {
    // Ctrl/Cmd-click toggles a note in the selection.
    editor.selectNotes(isInSelection ? selected.filter((id) => id !== hit.note.id) : [...selected, hit.note.id]);
    return;
  }
  const ids = isInSelection ? selected : [hit.note.id];
  editor.selectNotes(ids);
  const notesById = new Map(target.notes.map((note) => [note.id, note]));
  const originals = ids.map((id) => notesById.get(id)).filter((note): note is Note => !!note);
  if (hit.zone === 'end') {
    ctx.state.drag = { kind: 'resize', x0: x, anchor: hit.note, originals, dTick: 0 };
  } else {
    ctx.state.drag = {
      kind: 'move',
      x0: x,
      y0: y,
      anchor: hit.note,
      originals,
      duplicate: event.shiftKey,
      dTick: 0,
      keys: originals.map((note) => note.key),
    };
    auditionKey(ctx, hit.note.key, hit.note.velocity);
  }
  ctx.state.preview = new Map(originals.map((note) => [note.id, note]));
  if (ctx.state.drag.kind === 'move' && ctx.state.drag.duplicate) {
    ctx.state.preview = new Map();
    ctx.state.previewAdds = originals.map((note) => ({ ...note }));
  }
  ctx.invalidate('notes', 'lane', 'overlay');
}

/** The pointer moved during a move: the preview shifts by whole grid steps, and by keys (or scale steps). */
export function moveNotes(ctx: PianoRollContext, drag: MoveDrag, x: number, y: number, event: PointerEvent, target: EditTarget): void {
  const grid = snapTicksFor(ctx, target, event);
  const rawTick = drag.anchor.tick + (x - drag.x0) / ctx.vp.pxPerTick;
  let dTick = snapRound(rawTick, grid) - drag.anchor.tick;
  const earliestTick = Math.min(...drag.originals.map((note) => note.tick));
  if (earliestTick + dTick < 0) dTick = -earliestTick;
  const toKey = drag.anchor.key + keyAtY(ctx, y) - keyAtY(ctx, drag.y0);
  const scaleSnap = ctx.s.editor.getState().pianoRoll.scaleSnap;
  const keys = movedKeys(
    drag.originals.map((note) => note.key),
    drag.anchor.key,
    toKey,
    scaleSnap,
    target.songKey,
  );
  if (dTick === drag.dTick && keys.every((key, i) => key === drag.keys[i])) return;
  drag.dTick = dTick;
  drag.keys = keys;
  const moved = drag.originals.map((note, i) => ({ ...note, tick: note.tick + dTick, key: keys[i] as number }));
  if (drag.duplicate) ctx.state.previewAdds = moved;
  else ctx.state.preview = new Map(moved.map((note) => [note.id, note]));
  const anchorIndex = drag.originals.findIndex((note) => note.id === drag.anchor.id);
  auditionKey(ctx, keys[anchorIndex] ?? drag.anchor.key, drag.anchor.velocity);
  ctx.invalidate('notes', 'lane');
}

/** The pointer moved during a resize: the end snaps to the grid for all selected notes, none shorter than a step. */
export function resizeNotes(ctx: PianoRollContext, drag: ResizeDrag, x: number, event: PointerEvent, target: EditTarget): void {
  const grid = snapTicksFor(ctx, target, event);
  const anchorEnd = drag.anchor.tick + drag.anchor.length;
  const end = anchorEnd + (x - drag.x0) / ctx.vp.pxPerTick;
  let dTick = snapRound(end, grid) - anchorEnd;
  const shortestLength = Math.min(...drag.originals.map((note) => note.length));
  const shortest = Math.max(1, grid);
  if (shortestLength + dTick < shortest) dTick = shortest - shortestLength;
  if (dTick === drag.dTick) return;
  drag.dTick = dTick;
  ctx.state.preview = new Map(drag.originals.map((note) => [note.id, { ...note, length: note.length + dTick }]));
  ctx.invalidate('notes', 'lane');
}

/** Releasing a move: the notes move (or are copied, and the copies selected) as one undo step. */
export function commitMove(ctx: PianoRollContext, drag: MoveDrag, target: WritableTarget): void {
  const { patternId, channelId } = target;
  // A Shift-click that never moved copies nothing (a copy exactly on top of the original is no use).
  const hasMoved = drag.dTick !== 0 || drag.keys.some((key, i) => key !== drag.originals[i]?.key);
  if (!hasMoved) return;
  if (drag.duplicate) {
    const copies = drag.originals.map((note, i) => ({
      ...note,
      id: newId.note(),
      tick: note.tick + drag.dTick,
      key: drag.keys[i] as number,
    }));
    ctx.s.history.transact('Duplicate notes', (draft) => addNotes(draft, patternId, channelId, copies));
    ctx.s.editor.getState().selectNotes(copies.map((note) => note.id));
    return;
  }
  const edits = drag.originals.map((note, i) => ({ id: note.id, tick: note.tick + drag.dTick, key: drag.keys[i] as number }));
  ctx.s.history.transact(drag.originals.length > 1 ? 'Move notes' : 'Move note', (draft) =>
    editNotes(draft, patternId, channelId, edits),
  );
}

/** Releasing a resize: the notes change length as one undo step, and new notes remember the length. */
export function commitResize(ctx: PianoRollContext, drag: ResizeDrag, target: WritableTarget): void {
  if (drag.dTick === 0) return;
  const { patternId, channelId } = target;
  const edits = drag.originals.map((note) => ({ id: note.id, length: note.length + drag.dTick }));
  ctx.s.history.transact('Resize notes', (draft) => editNotes(draft, patternId, channelId, edits));
  ctx.s.editor.getState().setPianoRoll({ lastLength: drag.anchor.length + drag.dTick });
}
