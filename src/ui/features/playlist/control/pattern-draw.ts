/**
 * Putting the current pattern on the playlist: the draw tool (a click on an empty cell opens a menu, a drag places one
 * clip), the paint tool (stamps the pattern along a track) and dropping a pattern from the browser.
 */
import { newId } from '@core/model/ids';
import type { Clip, LaneId, PatternClip, PatternId, Project, Tick } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { clipsSorted, patternClipLength } from '@core/query/playlist';
import { snapFloor } from '@core/time/snap';
import type { PlaylistContext } from './context';
import type { CreateDrag, PaintDrag, PressDrag } from './drag';
import { laneAtY, snapTicks } from './lanes';

/** A press on an empty cell becomes a drag (placing a clip) once the pointer has gone this far (px). */
const PRESS_SLOP_PX = 4;

/** A clip of the current pattern at `start` on `laneId`, as long as the pattern; null when no pattern is chosen. */
export function currentPatternClip(ctx: PlaylistContext, project: Project, laneId: LaneId, start: Tick): PatternClip | null {
  const patternId = ctx.s.view.getState().currentPatternId;
  if (!patternId || !project.patterns[patternId]) return null;
  return {
    kind: 'pattern',
    id: newId.clip(),
    laneId,
    start,
    length: patternClipLength(project, patternId),
    patternId,
    offset: 0,
  };
}

/**
 * A press on an empty cell with the draw or paint tool. Paint starts stamping at once; draw waits to see whether it
 * is a click (the empty-spot menu opens on release) or a drag (it places a clip).
 */
export function startPatternDraw(ctx: PlaylistContext, x: number, y: number, event: PointerEvent, project: Project): void {
  const lane = laneAtY(ctx, y, project);
  if (!lane) return;
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), snapTicks(ctx, project, event)));
  if (ctx.s.editor.getState().playlist.tool === 'paint') {
    const drag: PaintDrag = { kind: 'paint', gesture: ctx.s.history.gesture('Paint clips'), lane, last: tick, done: new Set() };
    ctx.state.drag = drag;
    paintAt(ctx, drag, x, project, event);
    return;
  }
  ctx.s.editor.getState().selectClips([]);
  ctx.state.drag = { kind: 'press', x0: x, y0: y, lane, tick, grab: ctx.vp.xToTick(x) - tick, moved: false };
}

/**
 * A press that has moved far enough turns into a drag that places a clip. Returns true when it did, and the caller
 * handles the same pointer move again as the new drag.
 */
export function turnPressIntoCreate(ctx: PlaylistContext, drag: PressDrag, x: number, y: number, project: Project): boolean {
  if (drag.moved || Math.hypot(x - drag.x0, y - drag.y0) < PRESS_SLOP_PX) return false;
  drag.moved = true;
  const clip = currentPatternClip(ctx, project, drag.lane, drag.tick);
  if (!clip) return false;
  ctx.state.drag = { kind: 'create', clip, grab: drag.grab };
  ctx.state.preview = [clip];
  ctx.invalidate('clips');
  return true;
}

/** The new clip follows the pointer, on the grid. */
export function moveCreate(ctx: PlaylistContext, drag: CreateDrag, x: number, y: number, project: Project, event: PointerEvent): void {
  const grid = snapTicks(ctx, project, event);
  const start = Math.max(0, snapFloor(ctx.vp.xToTick(x) - drag.grab + grid / 2, grid));
  const lane = laneAtY(ctx, y, project) ?? drag.clip.laneId;
  if (start === drag.clip.start && lane === drag.clip.laneId) return;
  drag.clip = { ...drag.clip, start, laneId: lane };
  ctx.state.preview = [drag.clip];
  ctx.invalidate('clips');
}

/** Releasing a created clip: it is added (one undo step) and selected. */
export function commitCreate(ctx: PlaylistContext, drag: CreateDrag): void {
  const clip = drag.clip;
  ctx.s.history.transact('Add clip', (draft) => addClips(draft, [clip]));
  ctx.s.editor.getState().selectClips([clip.id]);
}

/** Paint tool: stamps the current pattern in every free cell between the last stamp and the pointer. */
export function paintAt(ctx: PlaylistContext, drag: PaintDrag, x: number, project: Project, event: { altKey: boolean }): void {
  const patternId = ctx.s.view.getState().currentPatternId;
  if (!patternId) return;
  const cellLength = patternClipLength(project, patternId);
  const grid = Math.max(snapTicks(ctx, project, event), 1);
  const tick = Math.max(0, snapFloor(ctx.vp.xToTick(x), grid));
  const from = Math.min(drag.last, tick);
  const to = Math.max(drag.last, tick);
  drag.last = tick;
  const existing = clipsSorted(project.playlist.clips).filter((clip) => clip.laneId === drag.lane);
  const stamps: Clip[] = [];
  for (let cellStart = snapFloor(from, cellLength); cellStart <= to; cellStart += cellLength) {
    const isTaken = existing.some((clip) => clip.start < cellStart + cellLength && clip.start + clip.length > cellStart);
    if (drag.done.has(cellStart) || isTaken) continue;
    drag.done.add(cellStart);
    const clip = currentPatternClip(ctx, project, drag.lane, cellStart);
    if (clip) stamps.push(clip);
  }
  if (stamps.length > 0) drag.gesture.update((draft) => addClips(draft, stamps));
}

/** A pattern dragged in from the browser and dropped at (`lane`, `tick`): it becomes the current pattern and gets a clip. */
export function dropPattern(ctx: PlaylistContext, patternId: PatternId, lane: LaneId, tick: Tick, project: Project): void {
  if (!project.patterns[patternId]) return;
  ctx.s.view.getState().setCurrentPattern(patternId);
  const clip = currentPatternClip(ctx, project, lane, tick);
  if (!clip) return;
  ctx.s.history.transact('Add clip', (draft) => addClips(draft, [clip]));
  ctx.s.editor.getState().selectClips([clip.id]);
}
