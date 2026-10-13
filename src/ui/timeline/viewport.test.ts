import { describe, expect, it } from 'vitest';
import { Viewport } from './viewport';

describe('Viewport', () => {
  it('round-trips ticks and pixels at several zoom levels', () => {
    const vp = new Viewport(128);
    for (const ppt of [0.01, 0.1, 0.5, 2]) {
      vp.pxPerTick = ppt;
      vp.scrollTick = 1234;
      for (const tick of [1234, 2000, 99999]) expect(vp.xToTick(vp.tickToX(tick))).toBeCloseTo(tick, 6);
    }
    vp.rowHeight = 14;
    vp.scrollRow = 30.5;
    expect(vp.yToRow(vp.rowToY(60))).toBeCloseTo(60, 9);
  });

  it('zooms around the anchor point', () => {
    const vp = new Viewport(128);
    vp.width = 800;
    vp.pxPerTick = 0.1;
    vp.scrollTick = 1000;
    const anchor = vp.xToTick(400);
    vp.zoomX(2, 400);
    expect(vp.xToTick(400)).toBeCloseTo(anchor, 6);
    expect(vp.pxPerTick).toBeCloseTo(0.2, 9);
  });

  it('clamps scrolling to the content', () => {
    const vp = new Viewport(128);
    vp.width = 500;
    vp.height = 280;
    vp.pxPerTick = 0.1;
    vp.scrollBy(-10000, -10000, 20000);
    expect(vp.scrollTick).toBe(0);
    expect(vp.scrollRow).toBe(0);
    vp.scrollBy(1e9, 1e9, 20000);
    expect(vp.scrollTick).toBeCloseTo(20000 - 5000, 6);
    expect(vp.scrollRow).toBeCloseTo(128 - 20, 6);
  });
});
