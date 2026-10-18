/** The mouse cursor over the grid: it tells what a drag from here would do. */
import type { PlaylistContext } from './context';

/** Sets the grid's cursor from the tool, the drag in progress and what the pointer is over. */
export function updateCursor(ctx: PlaylistContext): void {
  const { state } = ctx;
  const tool = ctx.s.editor.getState().playlist.tool;
  const hover = state.hover;
  const drag = state.drag;
  const automationPart = state.autoHover?.hit.part;
  const levelHandle = drag?.kind === 'level' ? drag.handle : state.audioHot?.handle;
  const toolEditsClips = tool !== 'delete' && tool !== 'slice';
  let cursor = 'default';
  if (drag?.kind === 'pan' || drag?.kind === 'point') cursor = 'grabbing';
  else if (drag?.kind === 'tension') cursor = 'ns-resize';
  else if (levelHandle === 'gain' && toolEditsClips) cursor = 'ns-resize';
  else if (levelHandle && toolEditsClips) cursor = 'ew-resize';
  else if (drag?.kind === 'comp') cursor = 'col-resize';
  else if (tool === 'delete') cursor = 'not-allowed';
  else if (tool === 'comp' && hover?.clip.kind === 'audio' && hover.clip.take && !hover.clip.take.comp) cursor = 'col-resize';
  else if (automationPart === 'point') cursor = 'grab';
  else if (automationPart === 'handle') cursor = 'ns-resize';
  else if (tool === 'slice') cursor = hover ? 'col-resize' : 'default';
  else if (hover && hover.zone !== 'body') cursor = 'ew-resize';
  else if (hover) cursor = 'move';
  else if (tool === 'draw' || tool === 'paint') cursor = 'crosshair';
  ctx.els.gridHost.style.cursor = cursor;
}
