/**
 * The piano roll's keyboard cursor: one cell of the grid (a tick on the snap grid, and a key). It moves with the arrow
 * keys, selects what it is on, scrolls into view in one jump, and says where it is. Its state lives in
 * `ctx.state.keyboard`, not in React, so moving it re-renders nothing.
 */
import type { Note, NoteId, Tick } from '@core/model/types';
import { noteAt, notesInRect } from '@core/query/notes-hit';
import { ticksPerBar } from '@core/time/ppq';
import { joinParts, lengthText, plural, positionText, spokenKeyName, velocityNumber } from '../../../timeline/key-cursor/describe';
import { barTick, revealRow, revealTicks, snapCursorTick, stepTick } from '../../../timeline/key-cursor/grid-math';
import type { CursorBox } from '../../../timeline/key-cursor/draw';
import type { KeyIntent } from '../../../timeline/key-cursor/keys';
import { keyForRow, rowForKey } from '../render';
import type { EditTarget, NoteCursor, PianoRollContext } from './context';
import { editTarget, gridTicksOf, maxScrollTick, patternEnd } from './target';
import { viewportChanged } from './viewport-control';

const SEMITONES_PER_OCTAVE = 12;
const LOWEST_KEY = 0;
const HIGHEST_KEY = 127;
/** The keyboard cursor box is at least this wide (px), so a cell squeezed by zoom still shows a cursor. */
const MIN_BOX_WIDTH_PX = 8;

/** The furthest tick the cursor may go: the end of what the view can scroll to, less one grid step. */
function lastCursorTick(ctx: PianoRollContext, target: EditTarget): Tick {
  return Math.max(0, maxScrollTick(ctx, target) - gridTicksOf(ctx, target));
}

/** The note under the cursor (the one drawn on top when notes overlap), or undefined over an empty cell. */
export function noteUnderCursor(target: EditTarget, cursor: NoteCursor): Note | undefined {
  return noteAt(target.notes, cursor.tick, cursor.key);
}

/**
 * Puts the cursor somewhere sensible when the grid gets the keyboard: on the first selected note when the selection is
 * not the one the keyboard left behind (it was made with the mouse meanwhile), else where it was; the very first time
 * with nothing selected, at the left edge of the view, halfway up it.
 */
export function placeCursorOnFocus(ctx: PianoRollContext, target: EditTarget): void {
  const keyboard = ctx.state.keyboard;
  const selection = ctx.s.editor.getState().noteSelection;
  const isNewSelection = selection !== keyboard.selectionWhenLeft && selection.length > 0;
  if (keyboard.isPlaced && !isNewSelection) return;
  keyboard.isPlaced = true;
  const selected = new Set(selection);
  const first = target.notes.find((note) => selected.has(note.id));
  if (first) {
    keyboard.cursor = { tick: first.tick, key: first.key };
    return;
  }
  const grid = gridTicksOf(ctx, target);
  const { vp } = ctx;
  const middleRow = vp.scrollRow + Math.floor(vp.height / vp.rowHeight / 2);
  keyboard.cursor = {
    tick: Math.ceil(vp.scrollTick / grid) * grid,
    key: Math.max(LOWEST_KEY, Math.min(HIGHEST_KEY, keyForRow(Math.round(middleRow)))),
  };
}

/** Moves the view, in one jump, so the cursor is on screen. */
export function revealCursor(ctx: PianoRollContext, target: EditTarget): void {
  const { cursor } = ctx.state.keyboard;
  const grid = gridTicksOf(ctx, target);
  const movedSideways = revealTicks(ctx.vp, cursor.tick, cursor.tick + grid, maxScrollTick(ctx, target));
  const movedUp = revealRow(ctx.vp, rowForKey(cursor.key));
  if (movedSideways || movedUp) {
    // Keys, like the wheel, tell the playhead follow to leave the view where it was put.
    ctx.follow.userScrolled();
    viewportChanged(ctx);
  }
}

/** The new cursor place for a move, page or edge key (not yet stored). */
function movedCursor(ctx: PianoRollContext, target: EditTarget, intent: KeyIntent): NoteCursor {
  const { cursor } = ctx.state.keyboard;
  const grid = gridTicksOf(ctx, target);
  const maxTick = lastCursorTick(ctx, target);
  let tick = cursor.tick;
  let key = cursor.key;
  if (intent.kind === 'move') {
    if (intent.columns !== 0) {
      const bar = ticksPerBar(target.project.transport.timeSig);
      tick = intent.isJump ? barTick(cursor.tick, intent.columns, bar, maxTick) : stepTick(cursor.tick, intent.columns, grid, maxTick);
    }
    const keysPerRow = intent.isJump ? SEMITONES_PER_OCTAVE : 1;
    key = cursor.key - intent.rows * keysPerRow;
  } else if (intent.kind === 'page') {
    key = cursor.key - intent.direction * SEMITONES_PER_OCTAVE;
  } else if (intent.kind === 'edge') {
    tick = intent.edge === 'start' ? 0 : snapCursorTick(patternEnd(target), grid, maxTick);
  }
  return { tick, key: Math.max(LOWEST_KEY, Math.min(HIGHEST_KEY, key)) };
}

/** Moves the cursor for a move, page or edge key; with Shift the selection grows over the cells it crosses. */
export function moveCursor(ctx: PianoRollContext, intent: Extract<KeyIntent, { kind: 'move' | 'page' | 'edge' }>): void {
  const target = editTarget(ctx);
  const keyboard = ctx.state.keyboard;
  if (intent.isExtend && !keyboard.anchor) {
    keyboard.anchor = { ...keyboard.cursor };
    keyboard.anchorSelection = [...ctx.s.editor.getState().noteSelection];
  }
  if (!intent.isExtend) keyboard.anchor = null;
  keyboard.cursor = movedCursor(ctx, target, intent);
  if (intent.isExtend) selectBetweenAnchorAndCursor(ctx, target);
  revealCursor(ctx, target);
  ctx.invalidate('overlay');
}

/** The notes in the rectangle of cells from the anchor to the cursor, added to what was selected when the anchor was set. */
function selectBetweenAnchorAndCursor(ctx: PianoRollContext, target: EditTarget): void {
  const { anchor, cursor, anchorSelection } = ctx.state.keyboard;
  if (!anchor) return;
  const grid = gridTicksOf(ctx, target);
  const firstTick = Math.min(anchor.tick, cursor.tick);
  const lastTick = Math.max(anchor.tick, cursor.tick) + grid;
  const inside = notesInRect(target.notes, firstTick, lastTick, anchor.key, cursor.key);
  const ids: NoteId[] = [...new Set([...anchorSelection, ...inside])];
  ctx.s.editor.getState().selectNotes(ids);
}

/** What a screen reader says for the cell the cursor is on: the key and place, and the note there if there is one. */
export function describeCursor(ctx: PianoRollContext, target: EditTarget): string {
  const { cursor } = ctx.state.keyboard;
  const timeSig = target.project.transport.timeSig;
  const where = `${spokenKeyName(cursor.key)}, ${positionText(cursor.tick, timeSig)}`;
  const note = noteUnderCursor(target, cursor);
  if (!note) return joinParts([where, 'empty']);
  const isSelected = ctx.s.editor.getState().noteSelection.includes(note.id);
  const isAtStart = note.tick === cursor.tick;
  return joinParts([
    where,
    isAtStart ? `note ${lengthText(note.length, timeSig)}` : `inside a note ${lengthText(note.length, timeSig)} long that starts at ${positionText(note.tick, timeSig)}`,
    `velocity ${velocityNumber(note.velocity)}`,
    note.muted && 'muted',
    isSelected && 'selected',
  ]);
}

/** "12 notes, 3 selected" for the notes of the channel in the pattern. */
export function describeNotes(ctx: PianoRollContext, target: EditTarget): string {
  const selected = ctx.s.editor.getState().noteSelection.length;
  return joinParts([plural(target.notes.length, 'note'), selected > 0 ? `${selected} selected` : 'none selected']);
}

/** The text a screen reader reads as the grid's description: what is edited, how much is in it, where the cursor is. */
export function summaryText(ctx: PianoRollContext): string {
  const target = editTarget(ctx);
  if (!target.channelId) return 'No instrument channel is selected: pick one in the channel rack to edit its notes.';
  const channel = target.project.channels[target.channelId];
  const pattern = target.pattern;
  if (!pattern) return 'There is no pattern to edit yet.';
  const timeSig = target.project.transport.timeSig;
  const { cursor } = ctx.state.keyboard;
  return `Piano roll of ${channel?.name ?? 'the channel'} in ${pattern.name}: ${describeNotes(ctx, target)}. Cursor at ${spokenKeyName(cursor.key)}, ${positionText(cursor.tick, timeSig)}.`;
}

/** The box on the grid (px) the cursor is drawn around: the note under it, or the grid cell. */
export function cursorBox(ctx: PianoRollContext, target: EditTarget): CursorBox {
  const { vp } = ctx;
  const { cursor } = ctx.state.keyboard;
  const note = noteUnderCursor(target, cursor);
  const y = vp.rowToY(rowForKey(cursor.key));
  if (note) {
    const x = vp.tickToPx(note.tick);
    return { x, y: y + 1, w: Math.max(MIN_BOX_WIDTH_PX, note.length * vp.pxPerTick - 1), h: vp.rowHeight - 2 };
  }
  const x = vp.tickToPx(cursor.tick);
  const width = Math.max(MIN_BOX_WIDTH_PX, gridTicksOf(ctx, target) * vp.pxPerTick - 1);
  return { x, y: y + 1, w: width, h: vp.rowHeight - 2 };
}
