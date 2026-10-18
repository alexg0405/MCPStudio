/** The mouse cursor over the grid and the hint bar text: they tell what a drag from here would do. */
import type { PianoRollContext } from './context';

/** Sets the grid's cursor from the tool, the drag in progress and what the pointer is over. */
export function updateCursor(ctx: PianoRollContext): void {
  const tool = ctx.s.editor.getState().pianoRoll.tool;
  const hover = ctx.state.hover;
  let cursor = 'default';
  if (ctx.state.drag?.kind === 'pan') cursor = 'grabbing';
  else if (tool === 'delete') cursor = 'not-allowed';
  else if (tool === 'mute') cursor = hover ? 'pointer' : 'default';
  else if (tool === 'slice') cursor = hover ? 'col-resize' : 'default';
  else if (hover?.zone === 'end') cursor = 'ew-resize';
  else if (hover) cursor = tool === 'paint' ? 'copy' : 'move';
  else if (tool === 'draw' || tool === 'paint') cursor = 'crosshair';
  ctx.els.gridHost.style.cursor = cursor;
}

/** Shows `text` in the hint bar, but only when it differs from what is there (pointer moves are frequent). */
export function showHint(ctx: PianoRollContext, text: string): void {
  if (text === ctx.state.lastHint) return;
  ctx.state.lastHint = text;
  ctx.s.session.getState().setHint(text);
}
