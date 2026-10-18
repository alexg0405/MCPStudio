/**
 * The chord lane's geometry, kept apart from the canvas so it is tested in Node: where chords sit, what a pointer is over,
 * and what a drag turns a chord into (snapped, never shorter than the grid, never past tick 0).
 */
import type { ChordEvent, ChordId, Tick } from '@core/model/types';

/** How close (px) to a chord's edge a press counts as grabbing the edge. */
export const EDGE_GRAB_PX = 6;
/** A chord narrower than this (px) shows no name. */
export const MIN_LABEL_PX = 14;

/** A chord's place on screen. */
export interface ChordBox {
  id: ChordId;
  left: number;
  right: number;
}

/** Where on a chord bar the pointer is: its start edge, its body, or its end edge (the edges resize it). */
export type ChordZone = 'start' | 'body' | 'end';

/** What is under x: the chord and which part of it (edges win when the chord is wide enough to have a body). */
export function hitChord(boxes: readonly ChordBox[], x: number): { id: ChordId; zone: ChordZone } | null {
  for (const box of boxes) {
    if (x < box.left || x > box.right) continue;
    const width = box.right - box.left;
    const edge = Math.min(EDGE_GRAB_PX, width / 3);
    if (x <= box.left + edge) return { id: box.id, zone: 'start' };
    if (x >= box.right - edge) return { id: box.id, zone: 'end' };
    return { id: box.id, zone: 'body' };
  }
  return null;
}

/** The nearest multiple of `grid` (a grid of 1 or less leaves the tick as it is). */
export const snapToGrid = (tick: Tick, grid: Tick): Tick => (grid <= 1 ? Math.round(tick) : Math.round(tick / grid) * grid);

/** A chord's start and length. */
export interface ChordSpanTicks {
  tick: Tick;
  length: Tick;
}

/** What dragging the body of a chord by `deltaTicks` does: it moves, snapped, and stays at or after tick 0. */
export function movedSpan(original: ChordSpanTicks, deltaTicks: number, grid: Tick): ChordSpanTicks {
  const tick = Math.max(0, snapToGrid(original.tick + deltaTicks, grid));
  return { tick, length: original.length };
}

/** Dragging the left edge: the end stays, the start moves (at least one grid step of length is kept). */
export function startDraggedSpan(original: ChordSpanTicks, deltaTicks: number, grid: Tick): ChordSpanTicks {
  const end = original.tick + original.length;
  const minimum = Math.max(1, grid);
  const tick = Math.max(0, Math.min(end - minimum, snapToGrid(original.tick + deltaTicks, grid)));
  return { tick, length: end - tick };
}

/** Dragging the right edge: the start stays, the end moves (at least one grid step of length is kept). */
export function endDraggedSpan(original: ChordSpanTicks, deltaTicks: number, grid: Tick): ChordSpanTicks {
  const minimum = Math.max(1, grid);
  const end = Math.max(original.tick + minimum, snapToGrid(original.tick + original.length + deltaTicks, grid));
  return { tick: original.tick, length: end - original.tick };
}

/**
 * The span for a chord made by clicking (or dragging across) an empty place: from the snapped start to the snapped end of
 * the drag; a plain click takes `defaultLength` (a bar), cut short where the next chord begins.
 */
export function createdSpan(
  startTick: Tick,
  endTick: Tick,
  grid: Tick,
  defaultLength: Tick,
  chords: readonly Pick<ChordEvent, 'tick' | 'length'>[],
): ChordSpanTicks {
  const from = Math.max(0, snapToGrid(Math.min(startTick, endTick), grid));
  const dragged = Math.abs(endTick - startTick) >= Math.max(1, grid) ? snapToGrid(Math.max(startTick, endTick), grid) - from : 0;
  const nextStart = chords.map((chord) => chord.tick).filter((tick) => tick > from).sort((a, b) => a - b)[0];
  const wanted = dragged > 0 ? dragged : defaultLength;
  const room = nextStart !== undefined && dragged === 0 ? nextStart - from : wanted;
  return { tick: from, length: Math.max(1, Math.min(wanted, room)) };
}
