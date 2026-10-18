/** Finding what is under the pointer on the grid: the note, which part of it, the key and tick, and the notes a click draws. */
import { noteAt } from '@core/query/notes-hit';
import { newId } from '@core/model/ids';
import type { Note, Tick } from '@core/model/types';
import { clamp } from '../../../timeline/viewport';
import { keyForRow } from '../render';
import { drawKey, stampKeys } from '../stamp';
import type { EditTarget, Hit, PianoRollContext } from './context';

/** A note's end (the part that resizes) is at most this wide (px), and at least `MIN_EDGE_PX`. */
const MAX_EDGE_PX = 8;
const MIN_EDGE_PX = 3;
/** On a short note the end takes one third of its width, so the body stays grabbable. */
const EDGE_WIDTH_DIVISOR = 3;
/** The velocity of a newly drawn note (the MIDI default, 100 of 128). */
const NEW_NOTE_VELOCITY = 100 / 128;
/** The highest key. */
const HIGHEST_KEY = 127;

/** A pointer position in the pixels of `element` (the grid by default). */
export function localPoint(
  ctx: PianoRollContext,
  event: { clientX: number; clientY: number },
  element: HTMLElement = ctx.els.gridHost,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** The key (0-127) at height `y` of the grid or the keys strip. */
export function keyAtY(ctx: PianoRollContext, y: number): number {
  return clamp(keyForRow(Math.floor(ctx.vp.yToRow(y))), 0, HIGHEST_KEY);
}

/** The key a new note drawn at `y` gets (snapped to the scale when that's on). */
export function drawKeyAtY(ctx: PianoRollContext, y: number, target: EditTarget): number {
  return drawKey(keyAtY(ctx, y), ctx.s.editor.getState().pianoRoll.scaleSnap, target.songKey);
}

/** The notes drawing a note at (tick, key) creates: the note, or a chord when a chord stamp is chosen. */
export function notesToDraw(ctx: PianoRollContext, tick: Tick, key: number, length: Tick, target: EditTarget): Note[] {
  const settings = ctx.s.editor.getState().pianoRoll;
  return stampKeys(key, settings.chord, settings.inversion, target.songKey).map((stampKey) => ({
    id: newId.note(),
    tick,
    length,
    key: stampKey,
    velocity: NEW_NOTE_VELOCITY,
  }));
}

/** The note at (`x`, `y`) of the grid and the part of it, or null over empty space. */
export function hitTest(ctx: PianoRollContext, x: number, y: number, target: EditTarget): Hit | null {
  const note = noteAt(target.notes, ctx.vp.xToTick(x), keyAtY(ctx, y));
  if (!note) return null;
  const left = ctx.vp.tickToX(note.tick);
  const right = ctx.vp.tickToX(note.tick + note.length);
  const edge = Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, (right - left) / EDGE_WIDTH_DIVISOR));
  return { note, zone: right - x <= edge ? 'end' : 'body' };
}
