/**
 * The playlist's keyboard cursor: one cell of the grid (a tick on the snap grid, and a track), or a spot on the marker
 * lane above the tracks. It moves with the arrow keys, selects what it is on, scrolls into view in one jump, and says
 * where it is. Its state lives in `ctx.state.keyboard`, not in React, so moving it re-renders nothing.
 */
import type { AutomationClip, Clip, ClipId, LaneId, Marker, Project, Tick } from '@core/model/types';
import { markersSorted } from '@core/ops/markers';
import { clipAt, clipsInRect, clipsSorted, songLength } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { joinParts, lengthText, plural, positionText } from '../../../timeline/key-cursor/describe';
import type { CursorBox } from '../../../timeline/key-cursor/draw';
import { barTick, revealRow, revealTicks, snapCursorTick, stepTick } from '../../../timeline/key-cursor/grid-math';
import type { KeyIntent } from '../../../timeline/key-cursor/keys';
import { automationChannelOf, automationLabel } from './automation-edit';
import { contentToTick } from '../automation';
import type { ClipCursor, PlaylistContext } from './context';
import { boxOfClip } from './hit-test';
import { currentProject, maxScrollTick, shownLaneOrder, snapTicks } from './lanes';
import { viewportChanged } from './viewport-control';

/** The row of the marker lane, above the first track. */
export const MARKER_ROW = -1;
/** Ctrl, Cmd or Alt + Up or Down move this many tracks at once. */
export const TRACK_JUMP = 4;
/** The cursor box is at least this wide (px), so a cell squeezed by zoom still shows a cursor. */
const MIN_BOX_WIDTH_PX = 8;
/** The height (px) of the cursor's box on the marker lane, drawn along the top of the grid. */
const MARKER_BOX_HEIGHT_PX = 16;

/** The furthest tick the cursor may go: the end of what the view can scroll to, less one grid step. */
function lastCursorTick(ctx: PlaylistContext, project: Project): Tick {
  return Math.max(0, maxScrollTick(project) - snapTicks(ctx, project));
}

/** The track the cursor is on, or null on the marker lane. */
export function laneUnderCursor(ctx: PlaylistContext, project: Project): LaneId | null {
  const { row } = ctx.state.keyboard.cursor;
  return row < 0 ? null : (shownLaneOrder(ctx, project)[row] ?? null);
}

/** The clip under the cursor (the one drawn on top when clips overlap), or undefined over an empty cell or the marker lane. */
export function clipUnderCursor(ctx: PlaylistContext, project: Project): Clip | undefined {
  const lane = laneUnderCursor(ctx, project);
  return lane ? clipAt(clipsSorted(project.playlist.clips), ctx.state.keyboard.cursor.tick, lane) : undefined;
}

/** The first marker whose position is in the cursor's cell on the marker lane, or undefined. */
export function markerUnderCursor(ctx: PlaylistContext, project: Project): Marker | undefined {
  const { tick, row } = ctx.state.keyboard.cursor;
  if (row !== MARKER_ROW) return undefined;
  const grid = snapTicks(ctx, project);
  return markersSorted(project).find((marker) => marker.tick >= tick && marker.tick < tick + grid);
}

/** The index of the automation point in the cursor's cell of an automation clip, or -1 when there is none. */
export function automationPointInCell(ctx: PlaylistContext, clip: AutomationClip, project: Project): number {
  const channel = automationChannelOf(clip, project);
  if (!channel) return -1;
  const { tick } = ctx.state.keyboard.cursor;
  const grid = snapTicks(ctx, project);
  return channel.points.findIndex((point) => {
    const at = contentToTick(clip, point.tick);
    return at >= tick && at < tick + grid;
  });
}

/**
 * Puts the cursor somewhere sensible when the grid gets the keyboard: on the first selected clip when the selection is
 * not the one the keyboard left behind (it was made with the mouse meanwhile), else where it was; the very first time
 * with nothing selected, at the left edge of the view on the first track.
 */
export function placeCursorOnFocus(ctx: PlaylistContext): void {
  const keyboard = ctx.state.keyboard;
  const selection = ctx.s.editor.getState().clipSelection;
  const isNewSelection = selection !== keyboard.selectionWhenLeft && selection.length > 0;
  if (keyboard.isPlaced && !isNewSelection) return;
  keyboard.isPlaced = true;
  const project = currentProject(ctx);
  const first = selection.map((id) => project.playlist.clips[id]).find((clip): clip is Clip => !!clip);
  const row = first ? shownLaneOrder(ctx, project).indexOf(first.laneId) : -1;
  if (first && row >= 0) {
    keyboard.cursor = { tick: first.start, row };
    return;
  }
  const grid = snapTicks(ctx, project);
  keyboard.cursor = { tick: Math.ceil(ctx.vp.scrollTick / grid) * grid, row: Math.max(0, Math.floor(ctx.vp.scrollRow)) };
}

/** Moves the view, in one jump, so the cursor is on screen. */
export function revealCursor(ctx: PlaylistContext): void {
  const project = currentProject(ctx);
  const { cursor } = ctx.state.keyboard;
  const movedSideways = revealTicks(ctx.vp, cursor.tick, cursor.tick + snapTicks(ctx, project), maxScrollTick(project));
  const movedUp = revealRow(ctx.vp, Math.max(0, cursor.row));
  if (movedSideways || movedUp) {
    // Keys, like the wheel, tell the playhead follow to leave the view where it was put.
    ctx.follow.userScrolled();
    viewportChanged(ctx);
  }
}

/** The new cursor place for a move, page or edge key (not yet stored). */
function movedCursor(ctx: PlaylistContext, project: Project, intent: KeyIntent): ClipCursor {
  const { cursor } = ctx.state.keyboard;
  const grid = snapTicks(ctx, project);
  const maxTick = lastCursorTick(ctx, project);
  const bar = ticksPerBar(project.transport.timeSig);
  const lastRow = shownLaneOrder(ctx, project).length - 1;
  let { tick, row } = cursor;
  if (intent.kind === 'move') {
    if (intent.columns !== 0) tick = intent.isJump ? barTick(tick, intent.columns, bar, maxTick) : stepTick(tick, intent.columns, grid, maxTick);
    row += intent.rows * (intent.isJump ? TRACK_JUMP : 1);
  } else if (intent.kind === 'page') {
    tick = barTick(tick, intent.direction, bar, maxTick);
  } else if (intent.kind === 'edge') {
    tick = intent.edge === 'start' ? 0 : snapCursorTick(songLength(project), grid, maxTick);
  }
  return { tick, row: Math.max(MARKER_ROW, Math.min(lastRow, row)) };
}

/** Moves the cursor for a move, page or edge key; with Shift the selection grows over the cells it crosses. */
export function moveCursor(ctx: PlaylistContext, intent: Extract<KeyIntent, { kind: 'move' | 'page' | 'edge' }>): void {
  const project = currentProject(ctx);
  const keyboard = ctx.state.keyboard;
  if (intent.isExtend && !keyboard.anchor) {
    keyboard.anchor = { ...keyboard.cursor };
    keyboard.anchorSelection = [...ctx.s.editor.getState().clipSelection];
  }
  if (!intent.isExtend) keyboard.anchor = null;
  keyboard.cursor = movedCursor(ctx, project, intent);
  if (intent.isExtend) selectBetweenAnchorAndCursor(ctx, project);
  revealCursor(ctx);
  ctx.invalidate('overlay');
}

/** The clips in the rectangle of cells from the anchor to the cursor, added to what was selected when the anchor was set. */
function selectBetweenAnchorAndCursor(ctx: PlaylistContext, project: Project): void {
  const { anchor, cursor, anchorSelection } = ctx.state.keyboard;
  if (!anchor) return;
  const grid = snapTicks(ctx, project);
  const firstRow = Math.max(0, Math.min(anchor.row, cursor.row));
  const lastRow = Math.max(0, anchor.row, cursor.row);
  const lanes = new Set(shownLaneOrder(ctx, project).slice(firstRow, lastRow + 1));
  const firstTick = Math.min(anchor.tick, cursor.tick);
  const lastTick = Math.max(anchor.tick, cursor.tick) + grid;
  const inside = clipsInRect(clipsSorted(project.playlist.clips), firstTick, lastTick, lanes);
  const ids: ClipId[] = [...new Set([...anchorSelection, ...inside])];
  ctx.s.editor.getState().selectClips(ids);
}

/** "Track 2" or "Track 2 Drums": the track's number, and its name when it has one of its own. */
export function laneText(ctx: PlaylistContext, project: Project, row: number): string {
  const laneId = shownLaneOrder(ctx, project)[row];
  const lane = laneId ? project.playlist.lanes[laneId] : undefined;
  const number = `Track ${row + 1}`;
  const named = lane && lane.name !== number ? `${number} ${lane.name}` : number;
  return lane?.muted ? `${named} (muted)` : named;
}

/** What a clip is called out loud: "clip Pattern 1", "audio clip Vocal", "automation clip Cutoff". */
export function clipText(ctx: PlaylistContext, clip: Clip, project: Project): string {
  if (clip.kind === 'pattern') return `clip ${clip.name ?? project.patterns[clip.patternId]?.name ?? 'Pattern'}`;
  if (clip.kind === 'audio') return `audio clip ${clip.name ?? project.channels[clip.channelId]?.name ?? 'Audio'}`;
  return `automation clip ${clip.name ?? automationLabel(ctx, clip, project) ?? 'Automation'}`;
}

/** The sentence about an automation point: "point 2 of 4, 42 percent". */
export function pointText(ctx: PlaylistContext, clip: AutomationClip, index: number, project: Project): string {
  const channel = automationChannelOf(clip, project);
  const point = channel?.points[index];
  if (!channel || !point) return 'no point';
  const value = channel.target ? ctx.s.automation.format(channel.target, point.value, channel.range) : `${Math.round(point.value * 100)}%`;
  return `point ${index + 1} of ${channel.points.length}, ${value}`;
}

/** What a screen reader says for the cell the cursor is on: the track and place, and the clip, marker or point there. */
export function describeCursor(ctx: PlaylistContext): string {
  const project = currentProject(ctx);
  const { cursor } = ctx.state.keyboard;
  const timeSig = project.transport.timeSig;
  const place = positionText(cursor.tick, timeSig);
  if (cursor.row === MARKER_ROW) {
    const marker = markerUnderCursor(ctx, project);
    return joinParts(['Markers', place, marker ? `marker ${marker.name}` : 'empty']);
  }
  const where = joinParts([laneText(ctx, project, cursor.row), place]);
  const clip = clipUnderCursor(ctx, project);
  if (!clip) return joinParts([where, 'empty']);
  const isSelected = ctx.s.editor.getState().clipSelection.includes(clip.id);
  const isAtStart = clip.start === cursor.tick;
  const point = clip.kind === 'automation' ? automationPointInCell(ctx, clip, project) : -1;
  return joinParts([
    where,
    isAtStart ? clipText(ctx, clip, project) : `inside ${clipText(ctx, clip, project)} that starts at ${positionText(clip.start, timeSig)}`,
    lengthText(clip.length, timeSig),
    clip.kind === 'automation' && point >= 0 && pointText(ctx, clip, point, project),
    clip.muted && 'muted',
    isSelected && 'selected',
  ]);
}

/** "14 clips on 6 tracks, 2 selected" (and the markers, when there are any). */
export function describeContents(ctx: PlaylistContext, project: Project): string {
  const clips = Object.keys(project.playlist.clips).length;
  const markers = Object.keys(project.playlist.markers).length;
  const selected = ctx.s.editor.getState().clipSelection.length;
  return joinParts([
    `${plural(clips, 'clip')} on ${plural(shownLaneOrder(ctx, project).length, 'track')}`,
    selected > 0 ? `${selected} selected` : 'none selected',
    markers > 0 && plural(markers, 'marker'),
  ]);
}

/** Where the cursor is, for the description: "track 2, bar 3 beat 1" or "the marker lane, bar 3 beat 1". */
function cursorPlace(ctx: PlaylistContext, project: Project): string {
  const { cursor } = ctx.state.keyboard;
  const place = positionText(cursor.tick, project.transport.timeSig);
  return cursor.row === MARKER_ROW ? `the marker lane, ${place}` : `track ${cursor.row + 1}, ${place}`;
}

/** The text a screen reader reads as the grid's description: what the playlist holds and where the cursor is. */
export function summaryText(ctx: PlaylistContext): string {
  const project = currentProject(ctx);
  return `Playlist: ${describeContents(ctx, project)}. Cursor on ${cursorPlace(ctx, project)}.`;
}

/** The box on the grid (px) the cursor is drawn around: the clip under it, the marker lane's cell, or the grid cell. */
export function cursorBox(ctx: PlaylistContext): CursorBox {
  const { vp } = ctx;
  const project = currentProject(ctx);
  const { cursor } = ctx.state.keyboard;
  const grid = snapTicks(ctx, project);
  const width = Math.max(MIN_BOX_WIDTH_PX, grid * vp.pxPerTick - 1);
  if (cursor.row === MARKER_ROW) return { x: vp.tickToPx(cursor.tick), y: 1, w: width, h: MARKER_BOX_HEIGHT_PX };
  const clip = clipUnderCursor(ctx, project);
  const box = clip && clip.kind !== 'automation' ? boxOfClip(ctx, clip, project) : null;
  if (box) return { x: box.x, y: box.y, w: box.w, h: box.h };
  return { x: vp.tickToPx(cursor.tick), y: vp.rowToY(cursor.row) + 1, w: width, h: vp.rowHeight - 2 };
}
