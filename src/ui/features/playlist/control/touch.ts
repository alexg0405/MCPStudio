/**
 * Touch on the playlist: the grid, the ruler and the track headers are touch surfaces (`ui/touch/surface.ts`). One finger
 * does what the current tool does with a mouse; two fingers pan and pinch the view; a finger that rests opens the menu
 * that a right-click or the clip's ▾ button opens. A right-click itself deletes with the mouse, so a long press does not
 * stand in for it on a clip: it opens the clip's menu, where Delete is one tap away.
 */
import { snapFloor, snapRound } from '@core/time/snap';
import type { CleanupList } from '../../../timeline/listeners';
import { attachTouchSurface } from '../../../touch/surface';
import type { TwoFingerFrame } from '../../../touch/recognizer';
import { automationTargetAt } from './automation-edit';
import type { PlaylistContext } from './context';
import { hitTest, localPoint } from './hit-test';
import { currentProject, laneAtY, snapTicks } from './lanes';
import { markerHit } from './marker-hit';
import { cancelDrag } from './pointer';
import { panAndZoom } from './viewport-control';

/** What a long press at a client point opens on the grid: a point's menu, a clip's menu, or the empty cell's menu. */
function openGridMenu(ctx: PlaylistContext, clientX: number, clientY: number): void {
  const project = currentProject(ctx);
  const at = { clientX, clientY };
  const { x, y } = localPoint(ctx, at);
  const hit = hitTest(ctx, x, y, project);
  const editor = ctx.s.editor.getState();
  const target = automationTargetAt(ctx, hit, x, y, project);
  if (target?.hit.part === 'point') {
    editor.selectClips([target.clip.id]);
    ctx.hooks.onPointMenu?.(target.clip, target.hit.index, at);
    return;
  }
  if (hit) {
    // A clip that is part of the selection keeps it (its menu can act on all of them).
    if (!editor.clipSelection.includes(hit.clip.id)) editor.selectClips([hit.clip.id]);
    ctx.hooks.onClipMenu?.(hit.clip, at);
    return;
  }
  const lane = laneAtY(ctx, y, project);
  if (!lane) return;
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), snapTicks(ctx, project)));
  ctx.hooks.onEmptyMenu?.(tick, lane, at);
}

/** What a long press on a track header opens: that track's menu. */
function openHeaderMenu(ctx: PlaylistContext, clientX: number, clientY: number): void {
  const project = currentProject(ctx);
  const { y } = localPoint(ctx, { clientX, clientY }, ctx.els.headers);
  const laneId = laneAtY(ctx, y, project);
  if (laneId) ctx.hooks.onLaneMenu?.(laneId, { clientX, clientY });
}

/** What a long press on the ruler opens: the marker's menu, or the menu of the spot. */
function openRulerMenu(ctx: PlaylistContext, clientX: number, clientY: number): void {
  const project = currentProject(ctx);
  const at = { clientX, clientY };
  const { x, y } = localPoint(ctx, at, ctx.els.ruler);
  const hit = markerHit(ctx, x, y);
  if (hit) ctx.hooks.onMarkerMenu?.(hit.id, at);
  else ctx.hooks.onRulerMenu?.(Math.max(0, snapRound(ctx.vp.xToTick(x), snapTicks(ctx, project))), at);
}

/** Makes the grid, the ruler and the track headers touch surfaces. */
export function listenToTouch(ctx: PlaylistContext, cleanups: CleanupList): void {
  const { els } = ctx;
  const twoFinger = (frame: TwoFingerFrame): void => panAndZoom(ctx, frame);
  const drop = (): void => cancelDrag(ctx);
  attachTouchSurface(els.gridHost, { cancelDrag: drop, twoFinger, longPress: (x, y) => openGridMenu(ctx, x, y) }, cleanups);
  attachTouchSurface(els.headers, { cancelDrag: drop, twoFinger, longPress: (x, y) => openHeaderMenu(ctx, x, y) }, cleanups);
  attachTouchSurface(els.ruler, { cancelDrag: drop, twoFinger, longPress: (x, y) => openRulerMenu(ctx, x, y) }, cleanups);
}
