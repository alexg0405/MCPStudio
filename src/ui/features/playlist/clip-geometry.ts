/** Where a clip sits on the playlist canvas: shared by drawing and hit testing. */
import type { Clip } from '@core/model/types';
import type { Viewport } from '../../timeline/viewport';

/** Height of a clip's title bar. */
export const TITLE_H = 13;

export interface ClipBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The body under the title bar (notes, waveform, automation curve). */
  bodyY: number;
  bodyH: number;
}

export function clipBox(vp: Viewport, row: number, c: Pick<Clip, 'start' | 'length'>): ClipBox {
  const y = vp.rowToY(row) + 1;
  const h = vp.rowHeight - 2;
  const x = vp.tickToX(c.start);
  const w = Math.max(3, c.length * vp.pxPerTick - 1);
  return { x, y, w, h, bodyY: y + TITLE_H + 1, bodyH: h - TITLE_H - 3 };
}
