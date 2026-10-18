/**
 * Retina (devicePixelRatio 2) drawing: grid lines, ruler marks, clip edges and piano-roll rows all land on
 * whole device pixels, and the grid line and the clip edge of one tick share a device pixel, at a fractional
 * scroll (the smooth follow). The renderers are called with a recording context, so no canvas is needed.
 */
import { describe, expect, it } from 'vitest';
import type { TimeSignature } from '@core/model/types';
import type { TimelineTheme } from '../../timeline/canvas';
import { Viewport } from '../../timeline/viewport';
import { clipBox } from './clip-geometry';
import { drawLanesGrid } from './lane-grid';
import { drawGrid } from '../piano-roll/render';

const DPR = 2;
const BAR = 3840;
const TS: TimeSignature = { num: 4, den: 4 };

interface Rect {
  fill: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A context that records every fillRect with the fill colour it was drawn in. */
function recorder() {
  const rects: Rect[] = [];
  const ctx = {
    fillStyle: '',
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ fill: ctx.fillStyle, x, y, w, h });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects };
}

/** Distinct colours per role, so each recorded rect can be told apart. */
const theme = new Proxy({} as Record<string, string>, { get: (_t, key) => String(key) }) as unknown as TimelineTheme;

function viewport(scrollTick: number, pxPerTick: number): Viewport {
  const vp = new Viewport(8);
  vp.width = 1000;
  vp.height = 200;
  vp.rowHeight = 14;
  vp.pxPerTick = pxPerTick;
  vp.scrollTick = scrollTick;
  vp.snapForFrame(DPR);
  return vp;
}

/** Device pixels: a CSS position times the pixel ratio. */
const onDevicePixel = (cssPx: number) => Math.abs(cssPx * DPR - Math.round(cssPx * DPR)) < 1e-9;

describe('retina drawing (devicePixelRatio 2)', () => {
  it('playlist grid: every line and band starts on a whole device pixel at a fractional scroll', () => {
    for (const scrollTick of [1234.37, 1234.61, 1301.9, 5555.5]) {
      const vp = viewport(scrollTick, 0.037);
      const { ctx, rects } = recorder();
      drawLanesGrid(ctx, vp, theme, TS, 8);
      expect(rects.length).toBeGreaterThan(10);
      for (const r of rects) {
        expect(onDevicePixel(r.x)).toBe(true);
        expect(onDevicePixel(r.y)).toBe(true);
      }
    }
  });

  it('playlist: a clip edge and the grid line of the same tick land on the same device pixel', () => {
    for (const scrollTick of [1234.37, 1234.61, 1301.9]) {
      const vp = viewport(scrollTick, 0.037);
      const { ctx, rects } = recorder();
      drawLanesGrid(ctx, vp, theme, TS, 8);
      // The bar lines are the 1 px wide rects in the bar colour.
      const bars = rects.filter((r) => r.fill === 'bar' && r.w === 1 && r.y === 0);
      for (const tick of [BAR, 2 * BAR, 5 * BAR]) {
        const line = bars.find((r) => Math.abs(r.x - vp.tickToX(tick)) <= 1 / DPR);
        expect(line, `grid line for tick ${tick}`).toBeDefined();
        // A clip starting on that tick, and one ending on another bar line.
        const box = clipBox(vp, 0, { start: tick, length: BAR });
        expect(box.x).toBe(line!.x);
        expect(onDevicePixel(box.x)).toBe(true);
        const end = bars.find((r) => Math.abs(r.x - vp.tickToX(tick + BAR)) <= 1 / DPR);
        expect(end).toBeDefined();
        // The clip stops one CSS pixel short of the next bar line, like the gap between clips.
        expect(box.x + box.w + 1).toBe(end!.x);
        expect(onDevicePixel(box.x + box.w)).toBe(true);
      }
    }
  });

  it('piano roll: row bands, hairlines and step lines all start on whole device pixels', () => {
    for (const scrollTick of [800.4, 801.7, 2222.2]) {
      const vp = viewport(scrollTick, 0.5);
      vp.scrollRow = 3.37;
      const { ctx, rects } = recorder();
      drawGrid(ctx, vp, theme, TS, BAR * 4);
      expect(rects.length).toBeGreaterThan(10);
      for (const r of rects) {
        expect(onDevicePixel(r.x)).toBe(true);
        expect(onDevicePixel(r.y)).toBe(true);
      }
    }
  });
});
