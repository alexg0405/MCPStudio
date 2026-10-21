/**
 * The keyboard of the sheet: a cursor that steps through the notes, and note entry like a notation program.
 *
 *   Left, Right            the previous or next note (Ctrl or Cmd: the previous or next bar; Shift: add it to the selection)
 *   Home, End              the first or last note
 *   Enter                  select or deselect the notes at the cursor
 *   Up, Down               move the selected notes a scale step (Shift: a semitone, Ctrl or Cmd: an octave)
 *   A to G                 put that note at the cursor, as long as the entry duration, and move on (Shift: sharp, Alt: flat)
 *   1 2 4 8 6 3            entry duration: whole, half, quarter, eighth, sixteenth, thirty-second (also changes selected notes)
 *   . and T                dotted and triplet entry duration
 *   R or 0                 a rest: move on without a note
 *   Delete, Backspace      delete the selected notes
 *   Ctrl or Cmd + A, Esc   select all, clear the selection
 *   ?                      say where the cursor is
 * Space is left alone: it stays Play / stop.
 */
import { deleteSelectedNotes, insertNoteAt, moveSelectedNotes, setSelectedDuration } from '@app/notation/actions';
import type { Services } from '@app/services';
import { DURATION_KEYS, entryName, entryTicks, keyForLetter, type EntryDuration, type PitchMove } from '@core/notation/edit';
import { beatText, describeEvent, type ScoreEvent } from '@core/notation/events';
import { keySignatureOf, spellKey, spellingName } from '@core/notation/spelling';
import type { NoteId } from '@core/model/types';
import type { SheetController } from './sheet-controller';

/** What the keys can say aloud. */
type Say = (text: string) => void;

const LETTER_CODES = new Set(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG']);

const entryOf = (s: Services): EntryDuration => s.editor.getState().sheet.entry;

/** The sorted, distinct start ticks of the notes and rests the cursor can stop on. */
function stopTicks(c: SheetController): number[] {
  return [...new Set(c.stops.map((stop) => stop.tick))].sort((a, b) => a - b);
}

/** "bar 3, beat 2" for a tick. */
function placeText(c: SheetController, tick: number): string {
  const bar = Math.floor(tick / c.barTicks);
  const timeSig = c.score?.timeSig ?? { num: 4, den: 4 };
  return `bar ${bar + 1}, ${beatText(tick - bar * c.barTicks, timeSig)}`;
}

/** The first stop that starts exactly at the cursor's tick (a note or chord before a rest, the top staff first). */
function stopAtCursor(c: SheetController): ScoreEvent | null {
  const here = c.stops.filter((stop) => stop.tick === c.cursor.tick);
  return here.find((stop) => stop.noteIds.length > 0) ?? here[0] ?? null;
}

/** What is said when the cursor lands on a tick: the note there, or just the place when it is empty. */
function describeCursor(s: Services, c: SheetController): string {
  const stop = stopAtCursor(c);
  if (!stop || !c.score) return `${placeText(c, c.cursor.tick)}, nothing here`;
  const selected = new Set<string>(s.editor.getState().noteSelection);
  const isSelected = stop.noteIds.length > 0 && stop.noteIds.every((id) => selected.has(id));
  return `${describeEvent(c.score, stop)}${isSelected ? ', selected' : ''}`;
}

function moveToStop(s: Services, c: SheetController, direction: 1 | -1, isExtend: boolean): string {
  const ticks = stopTicks(c);
  const length = c.score ? c.score.measures.length * c.barTicks : 0;
  let target: number | undefined;
  if (direction > 0) target = ticks.find((tick) => tick > c.cursor.tick) ?? Math.min(length - 1, c.cursor.tick + entryTicks(entryOf(s)));
  else target = [...ticks].reverse().find((tick) => tick < c.cursor.tick) ?? 0;
  if (target === undefined || target === c.cursor.tick) return direction > 0 ? 'That is the end of the sheet.' : 'That is the start of the sheet.';
  c.setCursor(target);
  const stop = stopAtCursor(c);
  if (stop && stop.noteIds.length > 0) {
    c.setCursor(target, keyOfStop(stop));
    if (isExtend) s.editor.getState().selectNotes([...new Set([...s.editor.getState().noteSelection, ...stop.noteIds])]);
  }
  return describeCursor(s, c);
}

/** The key the next typed note is measured from: the top note of the stop. */
function keyOfStop(stop: ScoreEvent): number {
  return stop.item.kind === 'chord' ? Math.max(...stop.item.heads.map((head) => head.key)) : 72;
}

function moveToBar(s: Services, c: SheetController, direction: 1 | -1): string {
  const bar = Math.floor(c.cursor.tick / c.barTicks);
  const target = Math.max(0, (bar + direction) * c.barTicks);
  if (target === c.cursor.tick) return 'That is the start of the sheet.';
  c.setCursor(target);
  return describeCursor(s, c);
}

function moveToEdge(s: Services, c: SheetController, edge: 'start' | 'end'): string {
  const ticks = stopTicks(c);
  const target = edge === 'start' ? ticks[0] : ticks[ticks.length - 1];
  if (target === undefined) return 'There are no notes.';
  c.setCursor(target);
  return describeCursor(s, c);
}

function toggleSelection(s: Services, c: SheetController): string {
  const stop = stopAtCursor(c);
  if (!stop || stop.noteIds.length === 0) return 'There is no note at the cursor.';
  const editor = s.editor.getState();
  const selected = new Set<NoteId>(editor.noteSelection);
  const isAll = stop.noteIds.every((id) => selected.has(id));
  for (const id of stop.noteIds) {
    if (isAll) selected.delete(id);
    else selected.add(id);
  }
  editor.selectNotes([...selected]);
  return describeCursor(s, c);
}

/** If nothing is selected, the notes at the cursor become the selection (so an edit key acts on what the cursor is on). */
function selectUnderCursor(s: Services, c: SheetController): boolean {
  if (s.editor.getState().noteSelection.length > 0) return true;
  const stop = stopAtCursor(c);
  if (!stop || stop.noteIds.length === 0) return false;
  s.editor.getState().selectNotes(stop.noteIds);
  return true;
}

function movePitch(s: Services, c: SheetController, direction: 1 | -1, move: PitchMove): string {
  if (!selectUnderCursor(s, c)) return 'No note is selected: move the cursor onto a note first.';
  const result = moveSelectedNotes(s, direction, move);
  if (!result.ok) return result.message;
  c.refresh();
  const stop = stopAtCursor(c);
  if (stop) c.setCursor(c.cursor.tick, keyOfStop(stop));
  return `${result.message}. ${describeCursor(s, c)}`;
}

/** Puts a note at the cursor, then moves the cursor on by its length. */
function typeNote(s: Services, c: SheetController, letter: string, accidental: number): string {
  const songKey = s.doc.getState().project.transport.key;
  const key = keyForLetter(letter, accidental, songKey, c.cursor.key);
  if (key === null) return 'That is not a note name.';
  const entry = entryOf(s);
  const result = insertNoteAt(s, { tick: c.cursor.tick, key }, entry);
  if (!result.ok) return result.message;
  const spelled = spellingName(spellKey(key, songKey, keySignatureOf(songKey)), { spoken: true });
  const where = placeText(c, c.cursor.tick);
  c.cursor = { tick: c.cursor.tick + entryTicks(entry), key };
  c.refresh();
  c.setCursor(c.cursor.tick, key);
  return `Added ${spelled}, ${entryName(entry)}, ${where}`;
}

/** A digit sets the entry duration, and changes the selected notes to it. */
function chooseDuration(s: Services, c: SheetController, base: EntryDuration['base']): string {
  const editor = s.editor.getState();
  const entry: EntryDuration = { ...editor.sheet.entry, base };
  editor.setSheet({ entry });
  if (editor.noteSelection.length === 0) return `Entry duration: ${entryName(entry)}`;
  const result = setSelectedDuration(s, entry);
  c.refresh();
  return result.message;
}

function toggleEntry(s: Services, flag: 'isDotted' | 'isTriplet'): string {
  const editor = s.editor.getState();
  const entry: EntryDuration = { ...editor.sheet.entry };
  entry[flag] = !entry[flag];
  if (flag === 'isDotted' && entry.isDotted) entry.isTriplet = false;
  if (flag === 'isTriplet' && entry.isTriplet) entry.isDotted = false;
  editor.setSheet({ entry });
  return `Entry duration: ${entryName(entry)}`;
}

function restAdvance(s: Services, c: SheetController): string {
  const entry = entryOf(s);
  c.setCursor(c.cursor.tick + entryTicks(entry));
  return `Rest of ${entryName(entry)}. ${describeCursor(s, c)}`;
}

function deleteAtCursor(s: Services, c: SheetController): string {
  if (!selectUnderCursor(s, c)) return 'Nothing here to delete.';
  const result = deleteSelectedNotes(s);
  c.refresh();
  return result.message;
}

/** The sentence "?" says: where the cursor is, what is selected and the entry duration. */
export function summaryOf(s: Services, c: SheetController): string {
  const count = s.editor.getState().noteSelection.length;
  const selected = count === 0 ? 'nothing selected' : `${count} ${count === 1 ? 'note' : 'notes'} selected`;
  return `${describeCursor(s, c)}. ${selected}. Entry duration: ${entryName(entryOf(s))}.`;
}

/** Handles a key press for the sheet. Returns true when the key was the sheet's. */
export function handleSheetKey(s: Services, c: SheetController, event: KeyboardEvent, say: Say): boolean {
  if (!c.score) return false;
  const said = (text: string): boolean => {
    say(text);
    return true;
  };
  const isMod = event.ctrlKey || event.metaKey;
  const key = event.key;
  if (key === '?' || (event.code === 'Slash' && event.shiftKey)) return said(summaryOf(s, c));
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const direction = key === 'ArrowRight' ? 1 : -1;
    return said(isMod ? moveToBar(s, c, direction) : moveToStop(s, c, direction, event.shiftKey));
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const move: PitchMove = isMod ? 'octave' : event.shiftKey ? 'semitone' : 'scale';
    return said(movePitch(s, c, key === 'ArrowUp' ? 1 : -1, move));
  }
  if (key === 'Home' || key === 'End') return said(moveToEdge(s, c, key === 'Home' ? 'start' : 'end'));
  if (key === 'Enter' && !isMod) return said(toggleSelection(s, c));
  if (key === 'Delete' || key === 'Backspace') return said(deleteAtCursor(s, c));
  if (isMod && event.code === 'KeyA' && !event.shiftKey) {
    s.editor.getState().selectNotes((c.state?.part.notes ?? []).map((note) => note.id));
    return said(`Selected all ${c.state?.part.notes.length ?? 0} notes`);
  }
  if (key === 'Escape') {
    if (s.editor.getState().noteSelection.length === 0) return false;
    s.editor.getState().selectNotes([]);
    return said('Selection cleared');
  }
  if (isMod) return false;
  if (LETTER_CODES.has(event.code)) return said(typeNote(s, c, event.code.slice(3), event.shiftKey ? 1 : event.altKey ? -1 : 0));
  if (event.shiftKey || event.altKey) return false;
  const base = DURATION_KEYS[key];
  if (base !== undefined) return said(chooseDuration(s, c, base));
  if (key === '.') return said(toggleEntry(s, 'isDotted'));
  if (event.code === 'KeyT') return said(toggleEntry(s, 'isTriplet'));
  if (event.code === 'KeyR' || key === '0') return said(restAdvance(s, c));
  return false;
}
