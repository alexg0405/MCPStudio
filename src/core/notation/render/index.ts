/** Score to SVG: lays the score out for a page width and draws each system as its own `<svg>` (so a printed page can break between them). */
import type { Score } from '../types';
import { renderSystem } from './draw';
import { layoutScore, type SheetLayout } from './layout';

/** A drawn score: the layout (for hit-testing and following) and one SVG string per system. */
export interface RenderedSheet {
  layout: SheetLayout;
  systems: string[];
}

/** Lays out and draws a score. `width` is the page width in layout pixels, `zoom` scales the drawing on screen. */
export function renderSheet(score: Score, options: { width: number; zoom: number }): RenderedSheet {
  const layout = layoutScore(score, { width: options.width });
  return { layout, systems: layout.systems.map((system) => renderSystem(score, system, { zoom: options.zoom })) };
}

export { SPACE } from './layout';
