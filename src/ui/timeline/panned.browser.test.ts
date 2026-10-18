/**
 * A panned layer shows exactly what a direct redraw would show, at any scroll, zoom and pixel ratio: the picture
 * is drawn once into a wider canvas and slid; the part of it that is in view must equal the same view drawn from
 * scratch. It also must not be drawn again while the view only scrolls inside what was drawn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drawLanesGrid } from '../features/playlist/lane-grid';
import { drawGrid } from '../features/piano-roll/render';
import { readTheme } from './canvas';
import { PannedLayer } from './panned';
import { Viewport } from './viewport';

const TS = { num: 4, den: 4 } as const;
const realDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

function setDpr(v: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => v });
}
afterEach(() => {
  if (realDpr) Object.defineProperty(window, 'devicePixelRatio', realDpr);
  else Reflect.deleteProperty(window, 'devicePixelRatio');
});

function viewport(scrollTick: number, pxPerTick: number, dpr: number): Viewport {
  const vp = new Viewport(12);
  vp.width = 700;
  vp.height = 160;
  vp.rowHeight = 20;
  vp.pxPerTick = pxPerTick;
  vp.scrollTick = scrollTick;
  vp.snapForFrame(dpr);
  return vp;
}

/** The view drawn directly: a fresh canvas the size of the view. */
function direct(vp: Viewport, dpr: number, draw: (ctx: CanvasRenderingContext2D, vp: Viewport) => void): ImageData {
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width * dpr);
  c.height = Math.round(vp.height * dpr);
  // Same kind of canvas as the layer's own (accelerated): a software canvas rasterizes fractional edges a little differently.
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(ctx, vp);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** What the panned canvas shows in the view: its pixels from the slide offset, as the browser would composite them. */
function inView(layer: PannedLayer, canvas: HTMLCanvasElement, vp: Viewport, dpr: number): ImageData {
  const out = document.createElement('canvas');
  out.width = Math.round(vp.width * dpr);
  out.height = Math.round(vp.height * dpr);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, Math.round(layer.offset() * dpr), 0);
  return ctx.getImageData(0, 0, out.width, out.height);
}

function differing(a: ImageData, b: ImageData): number {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs((a.data[i] as number) - (b.data[i] as number)) > 2 ||
      Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) > 2 ||
      Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number)) > 2
    )
      n++;
  }
  return n;
}

const CASES: [string, (c: CanvasRenderingContext2D, vp: Viewport) => void][] = [
  ['playlist grid', (c, vp) => drawLanesGrid(c, vp, readTheme(), TS, 12)],
  ['piano roll grid', (c, vp) => drawGrid(c, vp, readTheme(), TS, 3840 * 6)],
];

const vp0Width = () => 700;

describe('PannedLayer', () => {
  for (const dpr of [1, 2, 1.25]) {
    for (const [name, draw] of CASES) {
      it(`${name} at dpr ${dpr}: the slid picture equals a direct redraw at every scroll`, () => {
        setDpr(dpr);
        const canvas = document.createElement('canvas');
        const layer = new PannedLayer(canvas);
        let scroll = 800.37;
        const now = 1000;
        // (Zooms where no line falls exactly between two device pixels: there float noise may round either way.)
        for (const ppt of [0.037137, 0.201317]) {
          for (let i = 0; i < 12; i++) {
            scroll += 17.3 + i * 5.1;
            const vp = viewport(scroll, ppt, dpr);
            layer.paint(vp, 160, false, draw, now + i);
            const bad = differing(inView(layer, canvas, vp, dpr), direct(vp, dpr, draw));
            expect(bad, `${bad} pixels differ at scrollTick ${scroll}, ${ppt} px/tick`).toBe(0);
          }
        }
      });
    }
  }

  it('blit mode (the rulers): the view-sized canvas equals a direct redraw at every scroll', () => {
    for (const dpr of [1, 2]) {
      setDpr(dpr);
      const canvas = document.createElement('canvas');
      const layer = new PannedLayer(canvas, 'blit');
      const draw = CASES[1]![1];
      let scroll = 900.2;
      for (let i = 0; i < 14; i++) {
        scroll += 23.7 + i * 3;
        const vp = viewport(scroll, 0.037137, dpr);
        layer.paint(vp, 160, false, draw, 1000 + i);
        const shown = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        const bad = differing(shown, direct(vp, dpr, draw));
        expect(bad, `${bad} pixels differ at scrollTick ${scroll} (dpr ${dpr})`).toBe(0);
        expect(canvas.width).toBe(Math.round(vp.width * dpr));
      }
      // The picture was drawn wider than the view, and not again for each scroll.
      expect(layer.wide.width).toBeGreaterThan(vp0Width());
      expect(layer.draws).toBeLessThan(6);
    }
  });

  it('slides without drawing again while the view stays inside the picture, and draws again when it leaves', () => {
    setDpr(2);
    const canvas = document.createElement('canvas');
    const layer = new PannedLayer(canvas);
    const draw = CASES[0]![1];
    let scroll = 20_000;
    let now = 0;
    const step = (dt: number, moveBy: number, dirty = false) => {
      scroll += moveBy;
      now += dt;
      layer.paint(viewport(scroll, 0.04, 2), 160, dirty, draw, now);
    };
    step(16, 0);
    const first = layer.draws;
    // Still: an edit redraws exactly the view (no margins), as cheap as before.
    expect(layer.wide.width).toBe(700);
    // The view starts moving: the first moved frame draws the wide picture, the next ones only slide it.
    step(16, 30);
    const wideDraws = layer.draws;
    expect(wideDraws).toBe(first + 1);
    expect(layer.wide.width).toBeGreaterThan(1200);
    for (let i = 0; i < 20; i++) step(16, 4);
    expect(layer.draws).toBe(wideDraws);
    // Dirty (an edit) draws again; leaving the picture (a jump) too; so does a zoom.
    step(16, 4, true);
    expect(layer.draws).toBe(wideDraws + 1);
    step(16, 50_000);
    expect(layer.draws).toBe(wideDraws + 2);
    now += 16;
    layer.paint(viewport(scroll, 0.08, 2), 160, false, draw, now);
    expect(layer.draws).toBe(wideDraws + 3);
  });
});
