/**
 * What a key press means for a keyboard cursor in a canvas editor (playlist, piano roll, pitch editor), the same in all
 * of them. Pure: it reads the key event's fields, so it is unit-tested without a browser.
 *
 * The keys, by what they do (the editors say what a move means for them: a bar or an octave, a track or a semitone):
 *
 *   Arrows                      move the cursor by one grid step (left, right) or one row (up, down)
 *   Ctrl/Cmd + arrows           move by a bar (left, right) or an octave / four tracks (up, down)
 *   PageUp, PageDown            move by an octave (piano roll) or a bar (playlist)
 *   Home, End                   go to the start or the end
 *   Shift + any of those        extend the selection while moving
 *   Enter                       select what is under the cursor, or put something there when it is empty
 *   Insert, Shift + Enter       put something under the cursor
 *   Delete, Backspace           delete the selection (or what is under the cursor)
 *   Ctrl/Cmd + A, Escape        select everything, clear the selection
 *   Alt + arrows                move the selection by a step or a row (Alt + PageUp/PageDown: by a bar or octave)
 *   Alt + Shift + Left, Right   make the selection shorter or longer by a grid step
 *   Alt + Shift + Up, Down      raise or lower the value of what is under the cursor (velocity, automation point)
 *   ? (Shift + /)               say where the cursor is and what is selected
 *
 * Space is left alone on purpose: it stays Play / stop everywhere.
 */
import type { KeyEventLike } from '@core/commands/keymap';

/** One step along an axis: -1 (left, or up) or 1 (right, or down), 0 for none. */
export type Direction = -1 | 0 | 1;

/** What a key press asks a cursor to do. `rows` counts screen rows, so Up is -1 and Down is 1. */
export type KeyIntent =
  | { kind: 'move'; columns: Direction; rows: Direction; isJump: boolean; isExtend: boolean }
  | { kind: 'page'; direction: -1 | 1; isExtend: boolean }
  | { kind: 'edge'; edge: 'start' | 'end'; isExtend: boolean }
  | { kind: 'toggle' }
  | { kind: 'insert' }
  | { kind: 'delete' }
  | { kind: 'selectAll' }
  | { kind: 'clear' }
  | { kind: 'shift'; columns: Direction; rows: Direction; isJump: boolean }
  | { kind: 'resize'; direction: -1 | 1 }
  | { kind: 'adjust'; direction: -1 | 1 }
  | { kind: 'describe' };

const ARROWS: Readonly<Record<string, { columns: Direction; rows: Direction }>> = {
  ArrowLeft: { columns: -1, rows: 0 },
  ArrowRight: { columns: 1, rows: 0 },
  ArrowUp: { columns: 0, rows: -1 },
  ArrowDown: { columns: 0, rows: 1 },
};

/** The key of an event as the keymap names it: arrows and the like by `key`, letters by the physical key (Option on a Mac changes `key`). */
function plainKey(event: KeyEventLike): string {
  return /^Key[A-Z]$/.test(event.code) ? event.code : event.key;
}

/** Keys with Alt held: move the selection, resize it, or adjust its value. */
function withAlt(key: string, event: KeyEventLike): KeyIntent | null {
  if (key === 'PageUp') return { kind: 'shift', columns: 0, rows: -1, isJump: true };
  if (key === 'PageDown') return { kind: 'shift', columns: 0, rows: 1, isJump: true };
  const arrow = ARROWS[key];
  if (!arrow) return null;
  if (!event.shiftKey) return { kind: 'shift', columns: arrow.columns, rows: arrow.rows, isJump: false };
  if (arrow.columns !== 0) return { kind: 'resize', direction: arrow.columns === -1 ? -1 : 1 };
  return { kind: 'adjust', direction: arrow.rows === -1 ? 1 : -1 };
}

/** Keys with Ctrl or Cmd held: bigger jumps (with Shift: extending), and select all. */
function withMod(key: string, event: KeyEventLike): KeyIntent | null {
  if (key === 'KeyA') return event.shiftKey ? null : { kind: 'selectAll' };
  const arrow = ARROWS[key];
  if (arrow) return { kind: 'move', columns: arrow.columns, rows: arrow.rows, isJump: true, isExtend: event.shiftKey };
  return null;
}

function isQuestionMark(event: KeyEventLike): boolean {
  return event.key === '?' || (event.code === 'Slash' && event.shiftKey);
}

/** The intent behind a key press in a canvas editor with a keyboard cursor, or null when the key is not the cursor's. */
export function decodeKey(event: KeyEventLike): KeyIntent | null {
  const key = plainKey(event);
  const isMod = event.ctrlKey || event.metaKey;
  if (event.altKey) return isMod ? null : withAlt(key, event);
  if (isMod) return withMod(key, event);
  const isExtend = event.shiftKey;
  const arrow = ARROWS[key];
  if (arrow) return { kind: 'move', columns: arrow.columns, rows: arrow.rows, isJump: false, isExtend };
  switch (key) {
    case 'PageUp':
      return { kind: 'page', direction: -1, isExtend };
    case 'PageDown':
      return { kind: 'page', direction: 1, isExtend };
    case 'Home':
      return { kind: 'edge', edge: 'start', isExtend };
    case 'End':
      return { kind: 'edge', edge: 'end', isExtend };
    case 'Enter':
    case 'NumpadEnter':
      return isExtend ? { kind: 'insert' } : { kind: 'toggle' };
    case 'Insert':
      return { kind: 'insert' };
    case 'Delete':
    case 'Backspace':
      return isExtend ? null : { kind: 'delete' };
    case 'Escape':
      return isExtend ? null : { kind: 'clear' };
    default:
      return isQuestionMark(event) ? { kind: 'describe' } : null;
  }
}
