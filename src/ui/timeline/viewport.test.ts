import { describe, expect, it } from 'vitest';
import { snapToDevicePixel, Viewport } from './viewport';

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

  it('snaps a CSS-pixel position to the nearest whole device pixel', () => {
    expect(snapToDevicePixel(10.4, 1)).toBe(10);
    expect(snapToDevicePixel(10.6, 1)).toBe(11);
    expect(snapToDevicePixel(10.3, 2)).toBe(10.5);
    expect(snapToDevicePixel(10.2, 2)).toBe(10);
    // 1.25 device pixels per CSS pixel: whole device pixels are 0.8 CSS px apart.
    expect(snapToDevicePixel(8, 1.25)).toBeCloseTo(8, 9);
    expect(snapToDevicePixel(10.5, 1.25)).toBeCloseTo(10.4, 9); // 13.125 device px -> 13
    expect(snapToDevicePixel(10, 1.25)).toBeCloseTo(10.4, 9); // 12.5 device px rounds up to 13
  });

  it('keeps the scroll fractional but draws every tick on whole device pixels', () => {
    const dpr = 2;
    const vp = new Viewport(128);
    vp.width = 800;
    vp.pxPerTick = 0.037;
    for (const scrollTick of [0, 1000.3, 1234.77, 5555.5]) {
      vp.scrollTick = scrollTick;
      const devScroll = vp.snapForFrame(dpr);
      expect(Number.isInteger(devScroll)).toBe(true);
      expect(devScroll).toBe(Math.round(scrollTick * vp.pxPerTick * dpr));
      // Each tick's device x is its unscrolled device x minus the same whole-device-pixel scroll.
      for (const tick of [960, 1920, 4800, 7777]) {
        const devX = vp.tickToX(tick) * dpr;
        expect(devX).toBeCloseTo(tick * vp.pxPerTick * dpr - devScroll, 9);
      }
      // Hit-testing is the inverse of the same mapping, so a click lands where the line is drawn.
      expect(vp.xToTick(vp.tickToX(4800))).toBeCloseTo(4800, 6);
    }
    // The fractional scroll itself is untouched (motion stays even).
    expect(vp.scrollTick).toBe(5555.5);
  });

  it('uses the same offset for every layer drawn in a frame', () => {
    const vp = new Viewport(128);
    vp.pxPerTick = 0.05;
    vp.scrollTick = 321.9;
    vp.snapForFrame(1);
    const grid = vp.tickToX(960);
    const clip = vp.tickToX(960);
    const playhead = vp.tickToX(960);
    expect(grid).toBe(clip);
    expect(playhead).toBe(grid);
    // A new frame with no scroll change keeps the same offset.
    vp.snapForFrame(1);
    expect(vp.tickToX(960)).toBe(grid);
  });
});
