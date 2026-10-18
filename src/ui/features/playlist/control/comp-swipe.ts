/**
 * Comping: swiping across a take with the Comp tool (or Alt-drag with any tool) to use that part of it in the recording's
 * comp track. The swipe is previewed on the overlay and committed as one undo step on release.
 */
import { emitHint } from '@agstudio/sdk/ui';
import { chooseTake } from '@app/actions/comp';
import type { AudioClip, Project, Tick } from '@core/model/types';
import { takeGroups } from '@core/query/takes';
import { barSpan } from '@core/time/bars';
import { snapRound } from '@core/time/snap';
import type { Hit, PlaylistContext } from './context';
import { updateCursor } from './cursor';
import type { CompDrag } from './drag';
import { snapTicks } from './lanes';

/** A swipe counts as a drag once the pointer has gone this far (px) from where it started. */
const SWIPE_SLOP_PX = 3;

/** True when a press on `hit` starts a comp swipe: a take clip, with the Comp tool or Alt held. */
export function isCompSwipeStart(hit: Hit | null, tool: string, event: { altKey: boolean }): hit is Hit & { clip: AudioClip } {
  return hit?.clip.kind === 'audio' && !!hit.clip.take && !hit.clip.take.comp && (tool === 'comp' || event.altKey);
}

/** The song tick under x for a comp swipe (on the playlist grid). */
function tickAt(ctx: PlaylistContext, x: number, project: Project): Tick {
  return Math.max(0, snapRound(ctx.vp.xToTick(x), snapTicks(ctx, project)));
}

/** "take 2" for a take clip (its place among the takes of its group, in recording order). */
export function takeLabel(clip: AudioClip, project: Project): string {
  const group = takeGroups(project).find((g) => g.id === clip.take?.group);
  const number = group ? group.takes.findIndex((take) => take.index === clip.take?.index) + 1 : 0;
  return number > 0 ? `take ${number}` : 'this take';
}

/** The hint bar text while swiping from `t0` to `t1`. */
function swipeHint(clip: AudioClip, t0: Tick, t1: Tick, project: Project): string {
  const from = Math.min(t0, t1);
  const to = Math.max(t0, t1);
  const what = takeLabel(clip, project);
  if (to <= from) return `Comp: drag across ${what} to use that part in the comp`;
  const span = barSpan(from, to, project.transport.timeSig);
  return `Comp: release to use ${what} for ${span} (the comp track plays it, with a short crossfade at each end)`;
}

/** Starts a swipe on a take clip at `x`. */
export function startCompSwipe(ctx: PlaylistContext, clip: AudioClip, x: number, project: Project): void {
  const tick = tickAt(ctx, x, project);
  ctx.s.editor.getState().selectClips([clip.id]);
  ctx.state.drag = { kind: 'comp', clip, group: clip.take?.group ?? '', t0: tick, t1: tick, moved: false };
  emitHint(ctx.els.gridHost, swipeHint(clip, tick, tick, project));
  updateCursor(ctx);
  ctx.invalidate('overlay');
}

/** The swipe's end follows the pointer. */
export function moveCompSwipe(ctx: PlaylistContext, drag: CompDrag, x: number, project: Project): void {
  const tick = tickAt(ctx, x, project);
  if (tick === drag.t1) return;
  drag.t1 = tick;
  if (Math.abs(x - ctx.vp.tickToX(drag.t0)) > SWIPE_SLOP_PX) drag.moved = true;
  emitHint(ctx.els.gridHost, swipeHint(drag.clip, drag.t0, drag.t1, project));
  ctx.invalidate('overlay');
}

/** Releasing a swipe: the comp plays the swiped part of this take (one undo step), when it had audio there. */
export function commitCompSwipe(ctx: PlaylistContext, drag: CompDrag): void {
  if (!drag.moved || drag.t1 === drag.t0) return;
  const from = Math.min(drag.t0, drag.t1);
  const to = Math.max(drag.t0, drag.t1);
  const takeIndex = drag.clip.take?.index ?? 0;
  if (!chooseTake(ctx.s, drag.group, takeIndex, { from, to })) {
    emitHint(ctx.els.gridHost, 'That take has no audio there: swipe over the part of the take you want');
    return;
  }
  const project = ctx.s.doc.getState().project;
  const span = barSpan(from, to, project.transport.timeSig);
  emitHint(
    ctx.els.gridHost,
    `Comp: ${takeLabel(drag.clip, project)} plays ${span} · drag across another take to change it, Ctrl+Z undoes`,
  );
}
