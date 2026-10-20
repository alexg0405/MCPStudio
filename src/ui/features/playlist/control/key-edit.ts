/**
 * Editing the playlist from the keyboard cursor: put a clip or a marker at the cursor, select, delete, move, make
 * longer or shorter, change an automation point's value. Each goes through History like the mouse tools do (same ops,
 * one undo step; a held key's repeats merge into one step), and each returns the sentence a screen reader should say.
 */
import { addMarkerAt, deleteMarker, moveMarkerTo } from '@app/actions/markers';
import { tempoMapOf } from '@core/automation/tempo';
import type { Clip, Project } from '@core/model/types';
import { addClips, editClips } from '@core/ops/playlist';
import { lengthText, plural, positionText } from '../../../timeline/key-cursor/describe';
import type { KeyIntent } from '../../../timeline/key-cursor/keys';
import { clamp } from '../../../timeline/viewport';
import { playlistCommands } from '../commands';
import { markerRename } from '../markers';
import type { PlaylistContext } from './context';
import { addPointAtCursor, adjustPointAtCursor, removePointAtCursor } from './key-automation';
import {
  automationPointInCell,
  clipText,
  clipUnderCursor,
  describeCursor,
  laneText,
  laneUnderCursor,
  markerUnderCursor,
  MARKER_ROW,
  revealCursor,
  TRACK_JUMP,
} from './key-cursor';
import { currentProject, shownLaneOrder, snapTicks } from './lanes';
import { currentPatternClip } from './pattern-draw';

const NOTHING_SELECTED = 'No clip is selected. Move the cursor onto a clip and press Enter to select it.';
const NO_PATTERN = 'There is no pattern to place. Choose or make one with the pattern picker in the playlist toolbar.';

/**
 * The clips a keyboard edit acts on: the selection, or, when nothing is selected, the clip under the cursor (which
 * becomes the selection, so the person hears and sees what is being edited).
 */
function clipsToEdit(ctx: PlaylistContext, project: Project): Clip[] {
  const editor = ctx.s.editor.getState();
  const chosen = editor.clipSelection.map((id) => project.playlist.clips[id]).filter((clip): clip is Clip => !!clip);
  if (chosen.length > 0) return chosen;
  const underCursor = clipUnderCursor(ctx, project);
  if (!underCursor) return [];
  editor.selectClips([underCursor.id]);
  return [underCursor];
}

/**
 * After a rename started from the keyboard, Enter or Escape in the name field brings the focus back to the grid (the field
 * hides itself, which would otherwise drop the focus on the page, and the person would have to Tab back to their place).
 */
function returnFocusAfterRename(ctx: PlaylistContext): void {
  const input = ctx.els.markerRename;
  const stop = (): void => {
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', stop);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    stop();
    queueMicrotask(() => ctx.els.gridHost.focus());
  };
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', stop);
}

/** Puts a marker, a copy of the current pattern, or an automation point at the cursor. */
export function insertAtCursor(ctx: PlaylistContext): string {
  const project = currentProject(ctx);
  const { cursor } = ctx.state.keyboard;
  const timeSig = project.transport.timeSig;
  if (cursor.row === MARKER_ROW) {
    if (markerUnderCursor(ctx, project)) return 'There is already a marker here.';
    const id = addMarkerAt(ctx.s, cursor.tick);
    const name = currentProject(ctx).playlist.markers[id]?.name ?? 'Marker';
    return `Added marker ${name}, ${positionText(cursor.tick, timeSig)}. Press Enter on it to rename it.`;
  }
  const existing = clipUnderCursor(ctx, project);
  if (existing?.kind === 'automation') return addPointAtCursor(ctx, existing, project);
  if (existing) return `There is already ${clipText(ctx, existing, project)} here.`;
  const laneId = laneUnderCursor(ctx, project);
  if (!laneId) return 'There is no track here.';
  const clip = currentPatternClip(ctx, project, laneId, cursor.tick);
  if (!clip) return NO_PATTERN;
  ctx.s.history.transact('Add clip', (draft) => addClips(draft, [clip]));
  ctx.s.editor.getState().selectClips([clip.id]);
  const after = currentProject(ctx);
  return `Added ${clipText(ctx, clip, after)}, ${lengthText(clip.length, timeSig)}, ${laneText(ctx, after, cursor.row)}, ${positionText(clip.start, timeSig)}`;
}

/**
 * Enter: selects the clip under the cursor (or deselects it); on a marker it starts renaming it; on an empty cell it puts
 * a clip or marker there. Choosing a pattern clip also makes its pattern the current one, as clicking it does.
 */
export function toggleAtCursor(ctx: PlaylistContext): string {
  const project = currentProject(ctx);
  if (ctx.state.keyboard.cursor.row === MARKER_ROW) {
    const marker = markerUnderCursor(ctx, project);
    if (!marker) return insertAtCursor(ctx);
    markerRename.setState({ id: marker.id });
    returnFocusAfterRename(ctx);
    return `Renaming marker ${marker.name}. Type a new name and press Enter.`;
  }
  const clip = clipUnderCursor(ctx, project);
  if (!clip) return insertAtCursor(ctx);
  const editor = ctx.s.editor.getState();
  const isSelected = editor.clipSelection.includes(clip.id);
  editor.selectClips(isSelected ? editor.clipSelection.filter((id) => id !== clip.id) : [...editor.clipSelection, clip.id]);
  if (!isSelected && clip.kind === 'pattern') ctx.s.view.getState().setCurrentPattern(clip.patternId);
  return describeCursor(ctx);
}

/** Delete or Backspace: removes the marker, the automation point, the selected clips, or the clip under the cursor. */
export function deleteAtCursor(ctx: PlaylistContext): string {
  const project = currentProject(ctx);
  const timeSig = project.transport.timeSig;
  const { cursor } = ctx.state.keyboard;
  if (cursor.row === MARKER_ROW) {
    const marker = markerUnderCursor(ctx, project);
    if (!marker) return 'No marker here to delete.';
    deleteMarker(ctx.s, marker.id);
    return `Deleted marker ${marker.name}`;
  }
  const underCursor = clipUnderCursor(ctx, project);
  const selection = ctx.s.editor.getState().clipSelection;
  // A point of an automation clip that is not selected goes first; with the clip selected, Delete means the clip.
  if (underCursor?.kind === 'automation' && !selection.includes(underCursor.id) && automationPointInCell(ctx, underCursor, project) >= 0) {
    return removePointAtCursor(ctx, underCursor, project);
  }
  const doomed = clipsToEdit(ctx, project);
  if (doomed.length === 0) return 'Nothing here to delete.';
  playlistCommands.deleteSelection(ctx.s);
  if (doomed.length === 1) return `Deleted ${clipText(ctx, doomed[0] as Clip, project)}, ${positionText((doomed[0] as Clip).start, timeSig)}`;
  return `Deleted ${plural(doomed.length, 'clip')}`;
}

/** Ctrl or Cmd + A: selects every clip of the song. */
export function selectEveryClip(ctx: PlaylistContext): string {
  const count = Object.keys(currentProject(ctx).playlist.clips).length;
  playlistCommands.selectAll(ctx.s);
  return count === 0 ? 'There are no clips to select.' : `Selected all ${plural(count, 'clip')}`;
}

/** Escape: clears the selection and says so. Returns null when nothing was selected, so Escape goes on to the rest of the app. */
export function clearSelection(ctx: PlaylistContext): string | null {
  ctx.state.keyboard.anchor = null;
  if (ctx.s.editor.getState().clipSelection.length === 0) return null;
  ctx.s.editor.getState().selectClips([]);
  return 'Selection cleared';
}

/** Moves the marker under the cursor by a grid step, and the cursor with it. */
function shiftMarker(ctx: PlaylistContext, columns: number): string {
  const project = currentProject(ctx);
  const marker = markerUnderCursor(ctx, project);
  if (!marker) return 'No marker here to move.';
  const target = Math.max(0, marker.tick + columns * snapTicks(ctx, project));
  if (target === marker.tick) return 'Cannot move further that way.';
  moveMarkerTo(ctx.s, marker.id, target);
  ctx.state.keyboard.cursor = { ...ctx.state.keyboard.cursor, tick: target };
  revealCursor(ctx);
  return `Moved marker ${marker.name}. ${describeCursor(ctx)}`;
}

/** Alt + arrows: moves the selected clips (or the one under the cursor) by a grid step and tracks; the cursor goes with them. */
export function shiftSelection(ctx: PlaylistContext, intent: Extract<KeyIntent, { kind: 'shift' }>): string {
  if (ctx.state.keyboard.cursor.row === MARKER_ROW) return intent.columns === 0 ? 'Markers only move sideways.' : shiftMarker(ctx, intent.columns);
  const project = currentProject(ctx);
  const clips = clipsToEdit(ctx, project);
  if (clips.length === 0) return NOTHING_SELECTED;
  const order = shownLaneOrder(ctx, project);
  const rows = clips.map((clip) => order.indexOf(clip.laneId));
  const earliest = Math.min(...clips.map((clip) => clip.start));
  const dTick = Math.max(-earliest, intent.columns * snapTicks(ctx, project));
  const wantedLanes = intent.rows * (intent.isJump ? TRACK_JUMP : 1);
  const dLane = clamp(wantedLanes, -Math.min(...rows), order.length - 1 - Math.max(...rows));
  if (dTick === 0 && dLane === 0) return 'Cannot move further that way.';
  const underCursor = clipUnderCursor(ctx, project);
  const edits = clips.map((clip, i) => ({ id: clip.id, start: clip.start + dTick, laneId: order[(rows[i] as number) + dLane] ?? clip.laneId }));
  const tempo = tempoMapOf(project, 'song');
  ctx.s.history.transact(clips.length > 1 ? 'Move clips' : 'Move clip', (draft) => editClips(draft, edits, { tempo }), {
    mergeKey: 'keyboard-move-clips',
  });
  followMovedClip(ctx, underCursor, dTick, dLane);
  return `Moved ${plural(clips.length, 'clip')}. ${describeCursor(ctx)}`;
}

/** After a move the cursor goes with the clip it was on (a recording's clips stay on their own tracks, so the row is read back). */
function followMovedClip(ctx: PlaylistContext, clip: Clip | undefined, dTick: number, dLane: number): void {
  const project = currentProject(ctx);
  const { cursor } = ctx.state.keyboard;
  const landedLane = clip ? project.playlist.clips[clip.id]?.laneId : undefined;
  const landedRow = landedLane ? shownLaneOrder(ctx, project).indexOf(landedLane) : -1;
  ctx.state.keyboard.cursor = { tick: cursor.tick + dTick, row: landedRow >= 0 ? landedRow : cursor.row + dLane };
  revealCursor(ctx);
}

/** Alt + Shift + Left or Right: makes the selected clips (or the one under the cursor) one grid step shorter or longer at their end. */
export function resizeSelection(ctx: PlaylistContext, direction: -1 | 1): string {
  if (ctx.state.keyboard.cursor.row === MARKER_ROW) return 'Markers have no length.';
  const project = currentProject(ctx);
  const clips = clipsToEdit(ctx, project);
  if (clips.length === 0) return NOTHING_SELECTED;
  const grid = snapTicks(ctx, project);
  const shortest = Math.max(1, grid);
  const edits = clips.map((clip) => ({ id: clip.id, length: Math.max(shortest, clip.length + direction * grid) }));
  if (edits.every((edit, i) => edit.length === clips[i]?.length)) return 'Already as short as one grid step.';
  const tempo = tempoMapOf(project, 'song');
  ctx.s.history.transact('Resize clips', (draft) => editClips(draft, edits, { tempo }), { mergeKey: 'keyboard-resize-clips' });
  const first = edits[0] as { length: number };
  return `${plural(clips.length, 'clip')} now ${lengthText(first.length, project.transport.timeSig)} long`;
}

/** Alt + Shift + Up or Down: changes the value of the automation point under the cursor. */
export function adjustAtCursor(ctx: PlaylistContext, direction: -1 | 1): string {
  const project = currentProject(ctx);
  const clip = clipUnderCursor(ctx, project);
  if (clip?.kind !== 'automation') return 'Up and down with Alt and Shift change an automation point. Put the cursor on one first.';
  return adjustPointAtCursor(ctx, clip, direction, project);
}
