/**
 * The scrolling spectrogram: every new spectrum is one pixel column (time runs right to left, the newest at the right
 * edge; frequency is up, log axis, same bands as the spectrum), colored by level. The canvas shifts itself left and
 * paints only the new columns, so a frame costs a copy and a few columns, not a redraw of the history.
 */
import { readTheme, rgbaOf, themeVersion, type RGBA, type TimelineTheme } from '../../timeline/canvas';
import { SPECTRUM_BOTTOM_DB } from './spectrum-view';

/** The level that reads as the brightest color (dB): music rarely reaches 0 in a single 1/6-octave band. */
const BRIGHTEST_DB = -20;
const LUT_SIZE = 256;

export class SpectrogramView {
  private lut = new Uint8ClampedArray(LUT_SIZE * 4);
  private lutThemeVersion = -1;
  private column: ImageData | null = null;

  /** Empties the picture (the meter was restarted, or the canvas was resized). */
  clear(canvas: HTMLCanvasElement): void {
    const g = canvas.getContext('2d');
    if (g) g.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Makes the canvas's backing store match its CSS size; returns true when it changed (the picture was lost). */
  fit(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): boolean {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    this.column = null;
    return true;
  }

  /** Shifts the picture left by one column and paints the newest spectrum (`levels`: dB per band) at the right edge. */
  push(canvas: HTMLCanvasElement, levels: Float64Array): void {
    const g = canvas.getContext('2d');
    if (!g || levels.length === 0) return;
    const { width, height } = canvas;
    this.ensureLut(readTheme());
    g.globalCompositeOperation = 'copy';
    g.drawImage(canvas, -1, 0);
    g.globalCompositeOperation = 'source-over';
    if (!this.column || this.column.height !== height) this.column = g.createImageData(1, height);
    const pixels = this.column.data;
    for (let row = 0; row < height; row++) {
      // The lowest band at the bottom: a log axis is a straight line over the band index.
      const band = Math.min(levels.length - 1, Math.floor(((height - 1 - row) / height) * levels.length));
      const t = ((levels[band] as number) - SPECTRUM_BOTTOM_DB) / (BRIGHTEST_DB - SPECTRUM_BOTTOM_DB);
      const at = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1)))) * 4;
      const out = row * 4;
      pixels[out] = this.lut[at] as number;
      pixels[out + 1] = this.lut[at + 1] as number;
      pixels[out + 2] = this.lut[at + 2] as number;
      pixels[out + 3] = this.lut[at + 3] as number;
    }
    g.putImageData(this.column, width - 1, 0);
  }

  /** The theme's background, to its accent, to a light tint of it (rebuilt when the theme changes). */
  private ensureLut(theme: TimelineTheme): void {
    const version = themeVersion();
    if (version === this.lutThemeVersion) return;
    this.lutThemeVersion = version;
    const dark = rgbaOf(theme.bg);
    const middle = rgbaOf(theme.accent);
    const bright = rgbaOf(theme.accentLight);
    const blend = (from: RGBA, to: RGBA, t: number, channel: 0 | 1 | 2) => (from[channel] as number) * (1 - t) + (to[channel] as number) * t;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t = i / (LUT_SIZE - 1);
      const [from, to, within] = t < 0.65 ? [dark, middle, t / 0.65] : [middle, bright, (t - 0.65) / 0.35];
      for (const channel of [0, 1, 2] as const) this.lut[i * 4 + channel] = blend(from, to, within, channel);
      this.lut[i * 4 + 3] = 255;
    }
  }
}
