/** Finding what is under the pointer on the grid: the clip, which part of it, its ▾ button. */
import type { Clip, Project } from '@core/model/types';
import { clipAt, clipsSorted } from '@core/query/playlist';
import { CLIP_MENU_MIN_WIDTH, CLIP_MENU_SIZE, clipBox, type ClipBox } from '../clip-geometry';
import type { Hit, PlaylistContext, Zone } from './context';
import { laneAtY, laneRow } from './lanes';

/** A clip's start and end edges (the parts that resize) are at most this wide (px), and at least `MIN_EDGE_PX`. */
const MAX_EDGE_PX = 8;
const MIN_EDGE_PX = 3;
/** On a narrow clip each edge takes this fraction of its width, so the body stays grabbable. */
const EDGE_FRACTION_OF_WIDTH = 0.25;

/** A pointer position in the pixels of `element` (the grid by default). */
export function localPoint(
  ctx: PlaylistContext,
  event: { clientX: number; clientY: number },
  element: HTMLElement = ctx.els.gridHost,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** The clip at (`x`, `y`) of the grid and the part of it, or null over empty space. */
export function hitTest(ctx: PlaylistContext, x: number, y: number, project: Project): Hit | null {
  const lane = laneAtY(ctx, y, project);
  if (!lane) return null;
  const clip = clipAt(clipsSorted(project.playlist.clips), ctx.vp.xToTick(x), lane);
  if (!clip) return null;
  const left = ctx.vp.tickToX(clip.start);
  const right = ctx.vp.tickToX(clip.start + clip.length);
  const edge = Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, (right - left) * EDGE_FRACTION_OF_WIDTH));
  const zone: Zone = right - x <= edge ? 'end' : x - left <= edge ? 'start' : 'body';
  return { clip, zone };
}

/** The box of a clip on screen, or null when its track is not shown. */
export function boxOfClip(ctx: PlaylistContext, clip: Clip, project: Project): ClipBox | null {
  const row = laneRow(ctx, project, clip.laneId);
  return row < 0 ? null : clipBox(ctx.vp, row, clip);
}

/** True when (`x`, `y`) is on the ▾ button in a clip's title bar (the clip menu). */
export function isOnClipMenuButton(ctx: PlaylistContext, clip: Clip, x: number, y: number, project: Project): boolean {
  const row = laneRow(ctx, project, clip.laneId);
  if (row < 0 || clip.length * ctx.vp.pxPerTick < CLIP_MENU_MIN_WIDTH) return false;
  const left = ctx.vp.tickToX(clip.start);
  const top = ctx.vp.rowToY(row) + 1;
  return x >= left && x < left + CLIP_MENU_SIZE && y >= top && y < top + CLIP_MENU_SIZE;
}
