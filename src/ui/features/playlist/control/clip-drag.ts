/**
 * Moving and resizing clips with the pointer. While dragging, the clips are only previewed (`state.preview`); the
 * playlist changes once, as one undo step, when the button is let go. Shift copies instead of moving, and dropping the
 * clips on another window's drop target hands them to that window.
 */
import { emitHint } from '@agstudio/sdk/ui';
import { sourceSecondsAt, tickAtSourceSeconds, playbackMode } from '@core/audio/playback';
import { tempoMapOf } from '@core/automation/tempo';
import { clipTickOffset } from '@core/model/clips';
import { newId } from '@core/model/ids';
import type { AudioClip, Clip, LaneId, Project } from '@core/model/types';
import { addClips, editClips } from '@core/ops/playlist';
import { snapRound } from '@core/time/snap';
import { clamp } from '../../../timeline/viewport';
import { clipDropTargetAt, dropClipsOn, setClipDropOver } from '../../../clip-drop';
import type { Hit, PlaylistContext } from './context';
import type { MoveDrag, ResizeDrag } from './drag';
import { laneRow, shownLaneOrder, snapTicks } from './lanes';

/** The playback settings of an audio clip's channel (reverse, tempo follow, pitch). */
function playbackModeOf(clip: AudioClip, project: Project) {
  const channel = project.channels[clip.channelId];
  return playbackMode(channel?.kind === 'audioClip' ? channel : {});
}

/** How far left a clip's start can go before its trim reaches the start of its content (ticks). */
function trimRoom(clip: Clip, project: Project): number {
  if (clip.kind !== 'audio') return clipTickOffset(clip) ?? Infinity;
  const firstTick = tickAtSourceSeconds(clip, playbackModeOf(clip, project), tempoMapOf(project, 'song'), 0);
  return Math.max(0, Math.floor(clip.start - firstTick));
}

/**
 * A press on a clip with a clip-editing tool: with Ctrl/Cmd it toggles the clip in the selection, otherwise it selects
 * the clip (keeping a selection it is part of) and starts moving it, or resizing it by the edge it grabbed.
 */
export function startClipDrag(
  ctx: PlaylistContext,
  hit: Hit,
  x: number,
  y: number,
  event: PointerEvent,
  project: Project,
): void {
  const editor = ctx.s.editor.getState();
  const selection = editor.clipSelection;
  if (event.metaKey || event.ctrlKey) {
    const isSelected = selection.includes(hit.clip.id);
    editor.selectClips(isSelected ? selection.filter((id) => id !== hit.clip.id) : [...selection, hit.clip.id]);
    return;
  }
  const ids = selection.includes(hit.clip.id) ? selection : [hit.clip.id];
  editor.selectClips(ids);
  const originals = ids.map((id) => project.playlist.clips[id]).filter((clip): clip is Clip => !!clip);
  if (hit.clip.kind === 'pattern') ctx.s.view.getState().setCurrentPattern(hit.clip.patternId);
  if (hit.zone === 'body') {
    ctx.state.drag = {
      kind: 'move',
      x0: x,
      y0: y,
      anchor: hit.clip,
      originals,
      duplicate: event.shiftKey,
      dTick: 0,
      dLane: 0,
      over: null,
    };
  } else {
    ctx.state.drag = { kind: 'resize', x0: x, anchor: hit.clip, originals, side: hit.zone, dTick: 0 };
  }
  ctx.state.preview = originals.map((clip) => ({ ...clip }));
  ctx.invalidate('clips');
}

/** The pointer moved during a move: the preview shifts by whole grid steps and tracks. */
export function moveClips(ctx: PlaylistContext, drag: MoveDrag, x: number, y: number, event: PointerEvent, project: Project): void {
  const { vp } = ctx;
  const grid = snapTicks(ctx, project, event);
  let dTick = snapRound(drag.anchor.start + (x - drag.x0) / vp.pxPerTick, grid) - drag.anchor.start;
  const earliestStart = Math.min(...drag.originals.map((clip) => clip.start));
  if (earliestStart + dTick < 0) dTick = -earliestStart;
  const order = shownLaneOrder(ctx, project);
  const rows = drag.originals.map((clip) => laneRow(ctx, project, clip.laneId));
  const dLane = clamp(
    Math.floor(vp.yToRow(y)) - Math.floor(vp.yToRow(drag.y0)),
    -Math.min(...rows),
    order.length - 1 - Math.max(...rows),
  );
  if (dTick === drag.dTick && dLane === drag.dLane) return;
  drag.dTick = dTick;
  drag.dLane = dLane;
  ctx.state.preview = drag.originals.map((clip, i) => {
    const target = order[(rows[i] as number) + dLane] as LaneId;
    return { ...clip, start: clip.start + dTick, laneId: landsOnTrack(clip, target, drag.duplicate, project) };
  });
  ctx.invalidate('clips');
}

/**
 * The track a moved clip ends up on. A recording's clips stay on their tracks, and nothing else lands on those tracks
 * (`editClips` does the same); a copy goes where it is dropped.
 */
function landsOnTrack(clip: Clip, target: LaneId, isCopy: boolean, project: Project): LaneId {
  if (isCopy) return target;
  const isTakeClip = clip.kind === 'audio' && !!clip.take;
  const isTakeTrack = !!project.playlist.lanes[target]?.takes;
  return isTakeClip || isTakeTrack ? clip.laneId : target;
}

/** The pointer moved during a resize: the dragged edge snaps to the grid for all selected clips. */
export function resizeClips(ctx: PlaylistContext, drag: ResizeDrag, x: number, event: PointerEvent, project: Project): void {
  const grid = snapTicks(ctx, project, event);
  const shortest = Math.max(grid, 1);
  const ticksMoved = (x - drag.x0) / ctx.vp.pxPerTick;
  const dTick = drag.side === 'end' ? clampedEndChange(drag, ticksMoved, grid, shortest) : clampedStartChange(drag, ticksMoved, grid, shortest, project);
  if (dTick === drag.dTick) return;
  drag.dTick = dTick;
  ctx.state.preview =
    drag.side === 'end' ? drag.originals.map((clip) => ({ ...clip, length: clip.length + dTick })) : trimmedStarts(drag, dTick, project);
  ctx.invalidate('clips');
}

/** How much the end moves (ticks): to the grid, but no clip gets shorter than one grid step. */
function clampedEndChange(drag: ResizeDrag, ticksMoved: number, grid: number, shortest: number): number {
  const anchorEnd = drag.anchor.start + drag.anchor.length;
  const dTick = snapRound(anchorEnd + ticksMoved, grid) - anchorEnd;
  const shortestLength = Math.min(...drag.originals.map((clip) => clip.length));
  return shortestLength + dTick < shortest ? shortest - shortestLength : dTick;
}

/** How much the start moves (ticks): to the grid, within what every clip can give (no shorter than a step, no trim past its content). */
function clampedStartChange(drag: ResizeDrag, ticksMoved: number, grid: number, shortest: number, project: Project): number {
  const dTick = snapRound(drag.anchor.start + ticksMoved, grid) - drag.anchor.start;
  const mostToShorten = Math.min(...drag.originals.map((clip) => clip.length - shortest));
  const mostToLengthen = -Math.min(...drag.originals.map((clip) => Math.min(clip.start, trimRoom(clip, project))));
  return clamp(dTick, mostToLengthen, mostToShorten);
}

/** The left edge trims the start: the content stays in place (the offset follows). */
function trimmedStarts(drag: ResizeDrag, dTick: number, project: Project): Clip[] {
  const tempo = tempoMapOf(project, 'song');
  return drag.originals.map((clip) => {
    if (clip.kind === 'audio') {
      // The trim follows the clip's playback (pitch, tempo follow), so the audio stays put.
      const offsetSec = Math.max(0, sourceSecondsAt(clip, playbackModeOf(clip, project), tempo, clip.start + dTick));
      return { ...clip, start: clip.start + dTick, length: clip.length - dTick, offsetSec };
    }
    return { ...clip, start: clip.start + dTick, length: clip.length - dTick, offset: clip.offset + dTick };
  });
}

/**
 * A move whose pointer is over another window's drop target (ui/clip-drop.ts): the clips stop following it (they show
 * where they are) and the target is marked; true while that holds.
 */
export function handOffToDropTarget(ctx: PlaylistContext, drag: MoveDrag, event: PointerEvent): boolean {
  const over = clipDropTargetAt(event.clientX, event.clientY);
  if (over !== drag.over) {
    drag.over = over;
    setClipDropOver(over);
  }
  if (!over) return false;
  if (drag.dTick !== 0 || drag.dLane !== 0 || ctx.state.preview) {
    drag.dTick = 0;
    drag.dLane = 0;
    ctx.state.preview = null;
    ctx.invalidate('clips');
  }
  const count = drag.originals.length;
  emitHint(ctx.els.gridHost, `Release to put ${count === 1 ? 'this clip' : `these ${count} clips`} here (the playlist is not changed)`);
  return true;
}

/** Released over another window's drop target: it gets the clips; the playlist stays as it was. */
export function dropOnOtherWindow(drag: MoveDrag, target: HTMLElement): void {
  dropClipsOn(target, { clipIds: drag.originals.map((clip) => clip.id), duplicate: drag.duplicate });
}

/** Releasing a move: the clips move (or are copied and the copies selected), as one undo step. */
export function commitMove(ctx: PlaylistContext, drag: MoveDrag): void {
  const moved = ctx.state.preview;
  // A Shift-click that never moved copies nothing (a copy exactly on top of the original is no use).
  if (!moved || (drag.dTick === 0 && drag.dLane === 0)) return;
  if (drag.duplicate) {
    const copies = moved.map((clip) => ({ ...clip, id: newId.clip() }));
    ctx.s.history.transact('Duplicate clips', (draft) => addClips(draft, copies));
    ctx.s.editor.getState().selectClips(copies.map((clip) => clip.id));
    return;
  }
  const tempo = tempoMapOf(ctx.s.doc.getState().project, 'song');
  ctx.s.history.transact(moved.length > 1 ? 'Move clips' : 'Move clip', (draft) =>
    editClips(
      draft,
      moved.map((clip) => ({ id: clip.id, start: clip.start, laneId: clip.laneId })),
      { tempo },
    ),
  );
}

/** Releasing a resize: the clips change length (and trim) as one undo step. */
export function commitResize(ctx: PlaylistContext, drag: ResizeDrag): void {
  const changed = ctx.state.preview;
  if (!changed || drag.dTick === 0) return;
  const tempo = tempoMapOf(ctx.s.doc.getState().project, 'song');
  ctx.s.history.transact('Resize clips', (draft) =>
    editClips(
      draft,
      changed.map((clip) => ({
        id: clip.id,
        start: clip.start,
        length: clip.length,
        ...(clip.kind === 'audio' ? { offsetSec: clip.offsetSec } : { offset: clip.offset }),
      })),
      { tempo },
    ),
  );
}
