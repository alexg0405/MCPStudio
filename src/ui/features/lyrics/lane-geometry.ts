/**
 * The lyrics lane's geometry, kept apart from the canvas so it is tested in Node: where words sit and what a pointer is
 * over. What a drag turns a span into (snapped, never shorter than the grid, never before tick 0) is the same arithmetic
 * the chord lane uses, so it is shared from there.
 */
import type { LyricId, LyricWord, Tick } from '@core/model/types';
import { EDGE_GRAB_PX, type ChordSpanTicks as SpanTicks, type ChordZone as WordZone } from '../chords/lane-geometry';

export { createdSpan, endDraggedSpan, movedSpan, snapToGrid, startDraggedSpan } from '../chords/lane-geometry';
export type { SpanTicks, WordZone };

/** A word narrower than this (px) shows no text. */
export const MIN_LABEL_PX = 10;

/** A word's place on screen. */
export interface WordBox {
  id: LyricId;
  left: number;
  right: number;
}

/** What is under x: the word and which part of it (edges win when the word is wide enough to have a body). */
export function hitWord(boxes: readonly WordBox[], x: number): { id: LyricId; zone: WordZone } | null {
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

/** The words that overlap [from, to) as spans, for `createdSpan` to cut a new word short where the next one begins. */
export const spansOf = (words: readonly LyricWord[]): { tick: Tick; length: Tick }[] => words.map((word) => ({ tick: word.tick, length: word.length }));
