/** Small shared types and sizes of the Pitch editor's controller and its drawing. */

/** The width of the piano keys on the left, and the height of the time ruler on top, in px. */
export const KEYS_WIDTH = 56;
export const RULER_HEIGHT = 20;

/** The canvas layers that are drawn separately, so a change redraws only what it touches. */
export type Layer = 'grid' | 'content' | 'overlay' | 'keys' | 'ruler';

/** What a click on a note does: select and drag it, or cut it in two. */
export type PitchTool = 'select' | 'split';

/**
 * What a pointer drag is doing: moving the selected notes (`delta` semitones so far), drawing a selection box, panning the
 * view, or dragging the scrollbar's thumb.
 */
export type Drag =
  | { kind: 'move'; y0: number; anchor: number; anchorTarget: number; indices: number[]; delta: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: number[] }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'thumb'; x: number; scroll: number };
