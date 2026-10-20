/**
 * Editing notes from the keyboard cursor: put a note on the grid, select, delete, move, make longer or shorter, change
 * the velocity. Each one goes through History like the mouse tools do (same ops, one undo step; a held key's repeats
 * merge into one step), and each returns the sentence a screen reader should say about the result.
 */
import type { Note, NoteId } from '@core/model/types';
import { addNotes, editNotes, removeNotes } from '@core/ops/notes';
import { joinParts, lengthText, plural, positionText, spokenKeyName, velocityNumber } from '../../../timeline/key-cursor/describe';
import type { KeyIntent } from '../../../timeline/key-cursor/keys';
import { pianoRollCommands } from '../commands';
import { drawKey, movedKeys, stampName } from '../stamp';
import { asWritable, type EditTarget, type PianoRollContext, type WritableTarget } from './context';
import { describeCursor, noteUnderCursor, revealCursor } from './key-cursor';
import { notesToDraw } from './hit-test';
import { editTarget, gridTicksOf } from './target';

const SEMITONES_PER_OCTAVE = 12;
/** One Alt+Shift+Up or Down changes the velocity by this much (a MIDI step of 8, out of 128). */
const VELOCITY_STEP = 8 / 128;
/** No note is made quieter than this (1 of 128 would be silent: the lane tools stop at 0.01 too). */
const QUIETEST_VELOCITY = 0.01;

const NO_CHANNEL = 'There is no instrument channel selected: pick one in the channel rack first.';
const NOTHING_SELECTED = 'No note is selected. Move the cursor onto a note and press Enter to select it.';

/** What the edit commands need: a writable target (a channel and a pattern), or the sentence that says why not. */
function writableTarget(ctx: PianoRollContext): WritableTarget | null {
  return asWritable(editTarget(ctx));
}

/**
 * The notes a keyboard edit acts on: the selection, or, when nothing is selected, the note under the cursor (which
 * becomes the selection, so the person hears and sees what is being edited).
 */
function notesToEdit(ctx: PianoRollContext, target: EditTarget): Note[] {
  const editor = ctx.s.editor.getState();
  const selected = new Set(editor.noteSelection);
  const chosen = target.notes.filter((note) => selected.has(note.id));
  if (chosen.length > 0) return chosen;
  const underCursor = noteUnderCursor(target, ctx.state.keyboard.cursor);
  if (!underCursor) return [];
  editor.selectNotes([underCursor.id]);
  return [underCursor];
}

/** Puts a note (or the chosen chord) at the cursor, as long as the last note drawn, and selects it. */
export function insertAtCursor(ctx: PianoRollContext): string {
  const target = writableTarget(ctx);
  if (!target) return NO_CHANNEL;
  const settings = ctx.s.editor.getState().pianoRoll;
  const { cursor } = ctx.state.keyboard;
  const key = drawKey(cursor.key, settings.scaleSnap, target.songKey);
  const isTaken = target.notes.some((note) => note.key === key && note.tick === cursor.tick);
  if (isTaken) return `There is already a note at ${spokenKeyName(key)}, ${positionText(cursor.tick, target.project.transport.timeSig)}.`;
  const length = Math.max(1, settings.lastLength);
  const notes = notesToDraw(ctx, cursor.tick, key, length, target);
  ctx.s.history.transact(notes.length > 1 ? 'Add chord' : 'Add note', (draft) => addNotes(draft, target.patternId, target.channelId, notes));
  ctx.s.editor.getState().selectNotes(notes.map((note) => note.id));
  ctx.state.keyboard.cursor = { tick: cursor.tick, key };
  return addedSentence(ctx, notes);
}

function addedSentence(ctx: PianoRollContext, notes: readonly Note[]): string {
  const timeSig = editTarget(ctx).project.transport.timeSig;
  const first = notes[0] as Note;
  const where = positionText(first.tick, timeSig);
  if (notes.length === 1) return `Added ${spokenKeyName(first.key)}, ${where}, note ${lengthText(first.length, timeSig)}`;
  const name = stampName(notes.map((note) => note.key));
  return `Added ${name ? `chord ${name}` : 'chord'} of ${plural(notes.length, 'note')}, ${where}, ${lengthText(first.length, timeSig)} long`;
}

/** Enter: selects the note under the cursor, or deselects it when it was selected; on an empty cell it puts a note there. */
export function toggleAtCursor(ctx: PianoRollContext): string {
  const target = editTarget(ctx);
  if (!target.channelId) return NO_CHANNEL;
  const note = noteUnderCursor(target, ctx.state.keyboard.cursor);
  if (!note) return insertAtCursor(ctx);
  const editor = ctx.s.editor.getState();
  const isSelected = editor.noteSelection.includes(note.id);
  editor.selectNotes(isSelected ? editor.noteSelection.filter((id) => id !== note.id) : [...editor.noteSelection, note.id]);
  return describeCursor(ctx, target);
}

/** Delete or Backspace: removes the selected notes, or the one under the cursor when none is selected. */
export function deleteAtCursor(ctx: PianoRollContext): string {
  const target = writableTarget(ctx);
  if (!target) return NO_CHANNEL;
  const selected = new Set(ctx.s.editor.getState().noteSelection);
  let doomed = target.notes.filter((note) => selected.has(note.id));
  if (doomed.length === 0) {
    const underCursor = noteUnderCursor(target, ctx.state.keyboard.cursor);
    doomed = underCursor ? [underCursor] : [];
  }
  if (doomed.length === 0) return 'Nothing here to delete.';
  const ids: NoteId[] = doomed.map((note) => note.id);
  ctx.s.history.transact(ids.length > 1 ? 'Delete notes' : 'Delete note', (draft) =>
    removeNotes(draft, target.patternId, target.channelId, ids),
  );
  ctx.s.editor.getState().selectNotes([]);
  const timeSig = target.project.transport.timeSig;
  const first = doomed[0] as Note;
  if (doomed.length === 1) return `Deleted note ${spokenKeyName(first.key)}, ${positionText(first.tick, timeSig)}`;
  return `Deleted ${plural(doomed.length, 'note')}`;
}

/** Ctrl or Cmd + A: selects every note of the channel in the pattern. */
export function selectEveryNote(ctx: PianoRollContext): string {
  const target = editTarget(ctx);
  if (!target.channelId) return NO_CHANNEL;
  pianoRollCommands.selectAll(ctx.s);
  return target.notes.length === 0 ? 'There are no notes to select.' : `Selected all ${plural(target.notes.length, 'note')}`;
}

/** Escape: clears the selection and says so. Returns null when nothing was selected, so Escape goes on to the rest of the app. */
export function clearSelection(ctx: PianoRollContext): string | null {
  ctx.state.keyboard.anchor = null;
  if (ctx.s.editor.getState().noteSelection.length === 0) return null;
  ctx.s.editor.getState().selectNotes([]);
  return 'Selection cleared';
}

/** Alt + arrows: moves the selected notes (or the one under the cursor) by a grid step or a semitone; the cursor goes with them. */
export function shiftSelection(ctx: PianoRollContext, intent: Extract<KeyIntent, { kind: 'shift' }>): string {
  const target = writableTarget(ctx);
  if (!target) return NO_CHANNEL;
  const notes = notesToEdit(ctx, target);
  if (notes.length === 0) return NOTHING_SELECTED;
  const { cursor } = ctx.state.keyboard;
  const settings = ctx.s.editor.getState().pianoRoll;
  const earliest = Math.min(...notes.map((note) => note.tick));
  const dTick = Math.max(-earliest, intent.columns * gridTicksOf(ctx, target));
  const wantedKey = cursor.key - intent.rows * (intent.isJump ? SEMITONES_PER_OCTAVE : 1);
  const keys = movedKeys(notes.map((note) => note.key), cursor.key, wantedKey, settings.scaleSnap, target.songKey);
  const cursorKey = movedKeys([cursor.key], cursor.key, wantedKey, settings.scaleSnap, target.songKey)[0] ?? cursor.key;
  const didMove = dTick !== 0 || keys.some((key, i) => key !== notes[i]?.key);
  if (!didMove) return 'Cannot move further that way.';
  const edits = notes.map((note, i) => ({ id: note.id, tick: note.tick + dTick, key: keys[i] as number }));
  ctx.s.history.transact(notes.length > 1 ? 'Move notes' : 'Move note', (draft) => editNotes(draft, target.patternId, target.channelId, edits), {
    mergeKey: `keyboard-move:${target.channelId}`,
  });
  ctx.state.keyboard.cursor = { tick: cursor.tick + dTick, key: cursorKey };
  const after = editTarget(ctx);
  revealCursor(ctx, after);
  return `Moved ${plural(notes.length, 'note')}. ${describeCursor(ctx, after)}`;
}

/** Alt + Shift + Left or Right: makes the selected notes (or the one under the cursor) one grid step shorter or longer. */
export function resizeSelection(ctx: PianoRollContext, direction: -1 | 1): string {
  const target = writableTarget(ctx);
  if (!target) return NO_CHANNEL;
  const notes = notesToEdit(ctx, target);
  if (notes.length === 0) return NOTHING_SELECTED;
  const grid = gridTicksOf(ctx, target);
  const shortest = Math.max(1, grid);
  const edits = notes.map((note) => ({ id: note.id, length: Math.max(shortest, note.length + direction * grid) }));
  if (edits.every((edit, i) => edit.length === notes[i]?.length)) return 'Already as short as one grid step.';
  ctx.s.history.transact('Resize notes', (draft) => editNotes(draft, target.patternId, target.channelId, edits), {
    mergeKey: `keyboard-resize:${target.channelId}`,
  });
  const first = edits[0] as { length: number };
  ctx.s.editor.getState().setPianoRoll({ lastLength: first.length });
  const timeSig = target.project.transport.timeSig;
  return `${plural(notes.length, 'note')} now ${lengthText(first.length, timeSig)} long`;
}

/** Alt + Shift + Up or Down: makes the selected notes (or the one under the cursor) louder or quieter. */
export function adjustVelocity(ctx: PianoRollContext, direction: -1 | 1): string {
  const target = writableTarget(ctx);
  if (!target) return NO_CHANNEL;
  const notes = notesToEdit(ctx, target);
  if (notes.length === 0) return NOTHING_SELECTED;
  const edits = notes.map((note) => ({ id: note.id, velocity: Math.max(QUIETEST_VELOCITY, Math.min(1, note.velocity + direction * VELOCITY_STEP)) }));
  if (edits.every((edit, i) => edit.velocity === notes[i]?.velocity)) return direction > 0 ? 'Already at full velocity.' : 'Already at the quietest velocity.';
  ctx.s.history.transact('Change velocity', (draft) => editNotes(draft, target.patternId, target.channelId, edits), {
    mergeKey: `keyboard-velocity:${target.channelId}`,
  });
  const first = edits[0] as { velocity: number };
  return joinParts([`Velocity ${velocityNumber(first.velocity)}`, notes.length > 1 && `${plural(notes.length, 'note')}`]);
}
