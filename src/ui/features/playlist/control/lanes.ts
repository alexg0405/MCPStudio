/** Questions the editor asks about the project and the tracks on screen (which track is at a height, how far the song goes). */
import type { Lane, LaneId, Project, Tick } from '@core/model/types';
import { markersSorted } from '@core/ops/markers';
import { mutedLanes, songLength } from '@core/query/playlist';
import { visibleLaneOrder } from '@core/query/takes';
import { ticksPerBar } from '@core/time/ppq';
import { gridTicks } from '@core/time/snap';
import type { PlaylistContext } from './context';

/** The view scrolls on past the end of the song by this many bars, so there is room to place more. */
const EXTRA_BARS_PAST_SONG_END = 32;

/**
 * The sorted markers and the muted lanes of a playlist state, kept per state (the records are immutable, so the same
 * record gives the same answer): a frame that redraws the ruler and tracks would otherwise sort and build them again
 * every time.
 */
const sortedMarkersCache = new WeakMap<object, ReturnType<typeof markersSorted>>();
const mutedLanesCache = new WeakMap<object, ReturnType<typeof mutedLanes>>();
const laneRowCache = new WeakMap<object, Map<LaneId, number>>();

/** The markers in song order (cached per set of markers). */
export function sortedMarkersOf(project: Project): ReturnType<typeof markersSorted> {
  let sorted = sortedMarkersCache.get(project.playlist.markers);
  if (!sorted) {
    sorted = markersSorted(project);
    sortedMarkersCache.set(project.playlist.markers, sorted);
  }
  return sorted;
}

/** The tracks that do not play now (muted, or silenced by another track's solo), cached per playlist. */
export function mutedLanesOf(project: Project): ReturnType<typeof mutedLanes> {
  let muted = mutedLanesCache.get(project.playlist);
  if (!muted) {
    muted = mutedLanes(project.playlist);
    mutedLanesCache.set(project.playlist, muted);
  }
  return muted;
}

/** Each shown track's row, by track id (kept per order array: it is replaced when tracks move or fold). */
export function laneRowsOf(order: readonly LaneId[]): Map<LaneId, number> {
  let rows = laneRowCache.get(order);
  if (!rows) {
    rows = new Map(order.map((id, row): [LaneId, number] => [id, row]));
    laneRowCache.set(order, rows);
  }
  return rows;
}

/** The current project. */
export function currentProject(ctx: PlaylistContext): Project {
  return ctx.s.doc.getState().project;
}

/** The tracks on screen, in order: every track except the take tracks of folded take groups. */
export function shownLaneOrder(ctx: PlaylistContext, project: Project): readonly LaneId[] {
  return visibleLaneOrder(project, ctx.s.editor.getState().openTakes);
}

/** The tracks on screen as records, in order. */
export function shownLanes(ctx: PlaylistContext, project: Project): Lane[] {
  return shownLaneOrder(ctx, project)
    .map((id) => project.playlist.lanes[id])
    .filter((lane): lane is Lane => !!lane);
}

/** The track at height `y` of the grid, or null below the last track. */
export function laneAtY(ctx: PlaylistContext, y: number, project: Project): LaneId | null {
  const row = Math.floor(ctx.vp.yToRow(y));
  return shownLaneOrder(ctx, project)[row] ?? null;
}

/** The row of a track on screen (-1 when it is not shown, e.g. a folded take track). */
export function laneRow(ctx: PlaylistContext, project: Project, laneId: LaneId): number {
  return shownLaneOrder(ctx, project).indexOf(laneId);
}

/** The snap grid in ticks (1, i.e. none, with Alt held). */
export function snapTicks(ctx: PlaylistContext, project: Project, event?: { altKey: boolean }): Tick {
  if (event?.altKey) return 1;
  return gridTicks(ctx.s.editor.getState().playlist.snap, project.transport.timeSig, ctx.vp.pxPerTick);
}

/** The length of the scrollable area (ticks): the song, then `EXTRA_BARS_PAST_SONG_END` bars of room. */
export function maxScrollTick(project: Project): Tick {
  return Math.max(songLength(project), 0) + ticksPerBar(project.transport.timeSig) * EXTRA_BARS_PAST_SONG_END;
}
