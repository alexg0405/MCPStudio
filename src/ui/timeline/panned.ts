import { fitCanvas } from './canvas';
import { Viewport, snapToDevicePixel } from './viewport';

/** Draws one layer into `ctx` for the viewport `wide` (its width is the whole picture, margins included). */
export type PanDraw = (ctx: CanvasRenderingContext2D, wide: Viewport) => void;

/**
 * How long after the view last scrolled sideways a redraw still draws margins (ms). A layer that is redrawn while
 * the view is still (an edit, a hover) or zooming is drawn exactly the size of the view, as cheap as before; the
 * first redraw after the view starts scrolling (smooth follow, a hand scroll) draws a wider picture and the frames
 * after it only slide it.
 */
const MOVING_MS = 600;
/** Margin drawn on each side of the view while it scrolls, in view widths. Playback moves right, so more goes there. */
const LEFT = 0.3;
const RIGHT = 0.9;
/** A canvas wider than this (device pixels) is a risk (browser limits, memory): the margins shrink to stay under it. */
const MAX_DEVICE_WIDTH = 8192;

/**
 * A timeline layer (grid, clips, notes, ruler) drawn once into a canvas wider than the view, then slid sideways
 * while the view scrolls: a scroll frame costs a CSS transform (or one `drawImage`) instead of a full redraw, which
 * also built thousands of Path2D objects and strings every frame. The layer is drawn again only when it is dirty (an
 * edit, a theme change), when the zoom, the size, the vertical scroll or the pixel ratio changed, or when the view
 * leaves the part that was drawn.
 *
 * The slid picture is exactly what a direct redraw would show: the view's scroll is snapped to whole device pixels
 * (`Viewport.snapForFrame`) and every x is drawn through `tickToPx`, so the picture drawn from any origin is the
 * same picture moved by whole device pixels. Hit-testing is unaffected: it reads the viewport, never the canvas.
 *
 * Two ways to show the picture:
 *  - 'transform' (the default): the canvas itself is the wide picture, moved with a CSS transform by the compositor.
 *    It must sit in a box with `overflow: hidden` that is exactly the view's size (a position:absolute layer).
 *  - 'blit': the canvas stays the size of the view (it takes events and measures layout) and the picture is drawn
 *    into an offscreen canvas that is copied across when the view moved. For small layers (the rulers).
 */
export class PannedLayer {
  /** The viewport the picture was drawn with (wider than the view; left edge at `origin`). */
  readonly wide = new Viewport(0);
  /** CSS px of the scrolled world at the picture's left edge (a whole number of device pixels). */
  private origin = NaN;
  private wideWidth = 0;
  private viewWidth = -1;
  private lastScroll = NaN;
  private lastPxPerTick = NaN;
  private movedAt = -Infinity;
  private sizedWidth = -1;
  private sizedHeight = -1;
  private shiftPx = 0;
  private buffer: HTMLCanvasElement | null = null;
  private blitScroll = NaN;
  private blitTick = -1;
  /** How many times the picture was drawn (tests and the perf checks read it). */
  draws = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly mode: 'transform' | 'blit' = 'transform',
  ) {
    if (mode === 'transform') {
      canvas.style.willChange = 'transform';
      canvas.style.right = 'auto';
      canvas.style.bottom = 'auto';
    }
  }

  /**
   * Where the picture's left edge is in view coordinates (CSS px): a picture x is the view x minus this, so hit boxes
   * recorded while drawing (picture coordinates) are `x + offset()` in the view.
   */
  offset(): number {
    return this.shiftPx;
  }

  /**
   * Call once per frame, after `vp.snapForFrame()`. Draws the layer when it is stale (or `dirty`), then puts it at
   * the view's scroll. Returns true when it drew.
   */
  paint(vp: Viewport, height: number, dirty: boolean, draw: PanDraw, now: number): boolean {
    const dpr = vp.dpr;
    const w = this.wide;
    const scroll = snapToDevicePixel(vp.scrollTick * vp.pxPerTick, dpr);
    // Margins only for a plain scroll: a zoom moves the scroll too, but is redrawn from scratch every frame anyway.
    if (vp.pxPerTick !== this.lastPxPerTick) this.lastPxPerTick = vp.pxPerTick;
    else if (vp.scrollTick !== this.lastScroll) this.movedAt = now;
    this.lastScroll = vp.scrollTick;
    const covered = scroll >= this.origin && scroll + vp.width <= this.origin + this.wideWidth + 1e-6;
    let drew = false;
    if (
      dirty ||
      !covered ||
      this.viewWidth !== vp.width ||
      w.pxPerTick !== vp.pxPerTick ||
      w.scrollRow !== vp.scrollRow ||
      w.rowHeight !== vp.rowHeight ||
      w.rows !== vp.rows ||
      w.height !== height ||
      w.dpr !== dpr
    ) {
      const moving = now - this.movedAt < MOVING_MS;
      const room = Math.max(0, MAX_DEVICE_WIDTH / dpr - vp.width);
      const left = moving ? Math.min(scroll, vp.width * LEFT, room * 0.25) : 0;
      const right = moving ? Math.min(vp.width * RIGHT, room - left) : 0;
      const origin = snapToDevicePixel(scroll - left, dpr);
      const width = Math.ceil(scroll - origin + vp.width + right);
      this.origin = origin;
      this.wideWidth = width;
      this.viewWidth = vp.width;
      w.pxPerTick = vp.pxPerTick;
      w.minPxPerTick = vp.minPxPerTick;
      w.maxPxPerTick = vp.maxPxPerTick;
      w.scrollRow = vp.scrollRow;
      w.rowHeight = vp.rowHeight;
      w.rows = vp.rows;
      w.width = width;
      w.height = height;
      w.scrollTick = origin / vp.pxPerTick;
      w.snapForFrame(dpr);
      // The picture's left edge is a whole device pixel by construction; what is left over is float noise.
      w.drawShift = 0;
      let target = this.canvas;
      if (this.mode === 'blit') target = this.buffer ??= document.createElement('canvas');
      else if (this.sizedWidth !== width || this.sizedHeight !== height) {
        this.sizedWidth = width;
        this.sizedHeight = height;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
      }
      draw(fitCanvas(target, width, height), w);
      this.draws++;
      drew = true;
      this.blitTick = -1;
    }
    const shift = this.origin - scroll;
    if (this.mode === 'transform') {
      if (shift !== this.shiftPx) {
        this.shiftPx = shift;
        this.canvas.style.transform = shift === 0 ? '' : `translate3d(${shift}px,0,0)`;
      }
    } else {
      this.shiftPx = shift;
      if (drew || this.blitScroll !== scroll || this.blitTick !== this.draws) this.blit(vp, height, scroll, dpr);
    }
    return drew;
  }

  private blit(vp: Viewport, height: number, scroll: number, dpr: number): void {
    const buffer = this.buffer;
    if (!buffer) return;
    const ctx = fitCanvas(this.canvas, vp.width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const vw = this.canvas.width;
    const vh = this.canvas.height;
    ctx.clearRect(0, 0, vw, vh);
    // Source x in the picture, in device pixels (whole by construction); the buffer may be a pixel or two narrower.
    const sx = Math.round((scroll - this.origin) * dpr);
    ctx.drawImage(buffer, sx, 0, Math.min(vw, buffer.width - sx), Math.min(vh, buffer.height), 0, 0, Math.min(vw, buffer.width - sx), Math.min(vh, buffer.height));
    this.blitScroll = scroll;
    this.blitTick = this.draws;
  }
}
