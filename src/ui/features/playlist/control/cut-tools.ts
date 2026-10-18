/** The tools that cut clips apart or remove them: Slice (one click) and Delete (drag over clips, or the right button). */
import { tempoMapOf } from '@core/automation/tempo';
import type { Project } from '@core/model/types';
import { removeClips, splitClip } from '@core/ops/playlist';
import { snapRound } from '@core/time/snap';
import type { Hit, PlaylistContext } from './context';
import type { EraseDrag } from './drag';
import { hitTest } from './hit-test';
import { snapTicks } from './lanes';

/** Slice tool: cuts the clip under the pointer in two, at the grid line nearest the pointer (one undo step). */
export function sliceClip(ctx: PlaylistContext, hit: Hit, x: number, event: PointerEvent, project: Project): void {
  const cutTick = snapRound(ctx.vp.xToTick(x), snapTicks(ctx, project, event));
  const tempo = tempoMapOf(project, 'song');
  ctx.s.history.transact('Slice clip', (draft) => splitClip(draft, hit.clip.id, cutTick, tempo));
}

/** Starts erasing: every clip the pointer passes over until release is deleted, all in one undo step. */
export function startErase(ctx: PlaylistContext, x: number, y: number, project: Project): void {
  const drag: EraseDrag = { kind: 'erase', gesture: ctx.s.history.gesture('Delete clips'), done: new Set() };
  ctx.state.drag = drag;
  eraseAt(ctx, drag, x, y, project);
}

/** Deletes the clip under the pointer, once. */
export function eraseAt(ctx: PlaylistContext, drag: EraseDrag, x: number, y: number, project: Project): void {
  const hit = hitTest(ctx, x, y, project);
  if (!hit || drag.done.has(hit.clip.id)) return;
  drag.done.add(hit.clip.id);
  const id = hit.clip.id;
  drag.gesture.update((draft) => removeClips(draft, [id]));
  ctx.state.hover = null;
}
