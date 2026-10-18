/** The context menu of the grid: for the note under a right-click, or for an empty spot. */
import type { PianoRollContext, EditTarget, Hit, ScreenPoint } from './context';
import { keyAtY, localPoint } from './hit-test';

/**
 * Asks the window to open the menu at the click. A note that is not selected becomes the selection first (the menu acts
 * on the selection), so a right-click on a note never works on notes elsewhere.
 */
export function openMenu(ctx: PianoRollContext, at: ScreenPoint, target: EditTarget, hit: Hit | null): void {
  const { channelId, patternId } = target;
  const onMenu = ctx.hooks.onMenu;
  if (!onMenu || !channelId || !patternId) return;
  const { x, y } = localPoint(ctx, at);
  const tick = Math.max(0, Math.floor(ctx.vp.xToTick(x)));
  const key = keyAtY(ctx, y);
  if (!hit) {
    onMenu({ kind: 'empty', channelId, patternId, tick, key }, at);
    return;
  }
  const editor = ctx.s.editor.getState();
  if (!editor.noteSelection.includes(hit.note.id)) editor.selectNotes([hit.note.id]);
  const noteIds = ctx.s.editor.getState().noteSelection;
  onMenu({ kind: 'note', channelId, patternId, noteIds, tick, key }, at);
}
