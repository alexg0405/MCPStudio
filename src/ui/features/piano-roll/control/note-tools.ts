/** The tools that remove, mute or cut notes, and the rubber band that selects them. */
import type { Note } from '@core/model/types';
import { editNotes, removeNotes, sliceNote } from '@core/ops/notes';
import { notesInRect } from '@core/query/notes-hit';
import { snapRound } from '@core/time/snap';
import type { EditTarget, Hit, PianoRollContext, WritableTarget } from './context';
import type { EraseDrag, MarqueeDrag, MuteDrag } from './drag';
import { hitTest, keyAtY } from './hit-test';
import { snapTicksFor } from './target';

/** An erase drag counts as moved (so a right-click on empty space may open the menu) beyond this many px. */
const ERASE_CLICK_SLOP_PX = 3;

/** Slice tool: cuts the note under the pointer in two, at the grid line nearest the pointer (one undo step). */
export function sliceNoteAt(ctx: PianoRollContext, hit: Hit, x: number, event: PointerEvent, target: WritableTarget): void {
  const { patternId, channelId } = target;
  const cutTick = snapRound(ctx.vp.xToTick(x), snapTicksFor(ctx, target, event));
  ctx.s.history.transact('Slice note', (draft) => sliceNote(draft, patternId, channelId, hit.note.id, cutTick));
}

/** Starts erasing: every note the pointer passes over until release is deleted, all in one undo step. */
export function startErase(ctx: PianoRollContext, event: PointerEvent, x: number, y: number, target: EditTarget): void {
  const gesture = ctx.s.history.gesture('Delete notes');
  const drag: EraseDrag = { kind: 'erase', gesture, done: new Set(), clientX: event.clientX, clientY: event.clientY, moved: false };
  ctx.state.drag = drag;
  eraseAt(ctx, drag, x, y, target);
}

/** The erase drag's pointer moved: remember whether it is a drag rather than a click, and delete what is under it. */
export function moveErase(ctx: PianoRollContext, drag: EraseDrag, event: PointerEvent, x: number, y: number, target: EditTarget): void {
  if (Math.abs(event.clientX - drag.clientX) > ERASE_CLICK_SLOP_PX || Math.abs(event.clientY - drag.clientY) > ERASE_CLICK_SLOP_PX) {
    drag.moved = true;
  }
  eraseAt(ctx, drag, x, y, target);
}

/** Deletes the note under the pointer, once. */
export function eraseAt(ctx: PianoRollContext, drag: EraseDrag, x: number, y: number, target: EditTarget): void {
  const { patternId, channelId } = target;
  if (!patternId || !channelId) return;
  const hit = hitTest(ctx, x, y, target);
  if (!hit || drag.done.has(hit.note.id)) return;
  drag.done.add(hit.note.id);
  const id = hit.note.id;
  drag.gesture.update((draft) => removeNotes(draft, patternId, channelId, [id]));
  ctx.state.hover = null;
}

/** Starts muting: the note under the press decides whether the drag mutes or unmutes (one undo step). */
export function startMute(ctx: PianoRollContext, hit: Hit | null, x: number, y: number, target: EditTarget): void {
  const gesture = ctx.s.history.gesture(hit?.note.muted ? 'Unmute notes' : 'Mute notes');
  const drag: MuteDrag = { kind: 'mute', gesture, done: new Set(), muted: !hit?.note.muted };
  ctx.state.drag = drag;
  muteAt(ctx, drag, x, y, target);
}

/** Mutes or unmutes the note under the pointer, once. */
export function muteAt(ctx: PianoRollContext, drag: MuteDrag, x: number, y: number, target: EditTarget): void {
  const { patternId, channelId } = target;
  if (!patternId || !channelId) return;
  const hit = hitTest(ctx, x, y, target);
  if (!hit || drag.done.has(hit.note.id)) return;
  drag.done.add(hit.note.id);
  const edit = { id: hit.note.id, muted: drag.muted };
  drag.gesture.update((draft) => editNotes(draft, patternId, channelId, [edit]));
}

/** Starts a rubber band at (`x`, `y`). With Ctrl/Cmd it adds to the selection; otherwise it clears it. */
export function startMarquee(ctx: PianoRollContext, x: number, y: number, isAdding: boolean): void {
  const editor = ctx.s.editor.getState();
  ctx.state.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: isAdding ? [...editor.noteSelection] : [] };
  if (!isAdding) editor.selectNotes([]);
  ctx.invalidate('overlay');
}

/** The band's far corner follows the pointer; the selection is the notes it touches (plus what the band started with). */
export function moveMarquee(ctx: PianoRollContext, drag: MarqueeDrag, x: number, y: number, notes: readonly Note[]): void {
  drag.x1 = x;
  drag.y1 = y;
  const firstTick = ctx.vp.xToTick(Math.min(drag.x0, drag.x1));
  const lastTick = ctx.vp.xToTick(Math.max(drag.x0, drag.x1));
  const touched = notesInRect(notes, firstTick, lastTick, keyAtY(ctx, drag.y0), keyAtY(ctx, drag.y1));
  ctx.s.editor.getState().selectNotes([...new Set([...drag.base, ...touched])]);
  ctx.invalidate('overlay');
}
