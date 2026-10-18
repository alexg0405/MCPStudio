/** The rubber band that selects clips (Select tool, or the Draw tool with Ctrl/Cmd held). */
import type { Project } from '@core/model/types';
import { clipsInRect, clipsSorted } from '@core/query/playlist';
import type { PlaylistContext } from './context';
import type { MarqueeDrag } from './drag';
import { shownLaneOrder } from './lanes';

/** Starts a rubber band at (`x`, `y`). With Ctrl/Cmd it adds to the selection; otherwise it clears it. */
export function startMarquee(ctx: PlaylistContext, x: number, y: number, isAdding: boolean): void {
  const editor = ctx.s.editor.getState();
  ctx.state.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, base: isAdding ? [...editor.clipSelection] : [] };
  if (!isAdding) editor.selectClips([]);
  ctx.invalidate('overlay');
}

/** The band's far corner follows the pointer; the selection is the clips it touches (plus what the band started with). */
export function moveMarquee(ctx: PlaylistContext, drag: MarqueeDrag, x: number, y: number, project: Project): void {
  const { vp } = ctx;
  drag.x1 = x;
  drag.y1 = y;
  const firstRow = Math.max(0, Math.floor(vp.yToRow(Math.min(drag.y0, drag.y1))));
  const lastRow = Math.floor(vp.yToRow(Math.max(drag.y0, drag.y1)));
  const lanes = new Set(shownLaneOrder(ctx, project).slice(firstRow, lastRow + 1));
  const touched = clipsInRect(
    clipsSorted(project.playlist.clips),
    vp.xToTick(Math.min(drag.x0, drag.x1)),
    vp.xToTick(Math.max(drag.x0, drag.x1)),
    lanes,
  );
  ctx.s.editor.getState().selectClips([...new Set([...drag.base, ...touched])]);
  ctx.invalidate('overlay');
}
