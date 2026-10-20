/**
 * Colour-blind safe colours (headless Chrome): the shapes and patterns that carry what colour would, and the flag the
 * canvas editors read. Contrast and colour-blindness simulation of the palette itself: a11y-contrast.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { COLOR_PATTERNS, drawPattern, type ColorPattern } from '@ui/a11y/color-patterns';
import { drawSelectionMark } from '@ui/a11y/selection-mark';
import { invalidateTheme, readTheme } from '@ui/timeline/canvas';
import '@ui/theme/tokens.css';
import '@ui/theme/themes.css';

const SIZE = { w: 40, h: 20 };

/** The pixels a pattern paints on a transparent canvas, as an alpha-only string for comparing. */
function paint(pattern: ColorPattern): { filled: number; signature: string } {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE.w;
  canvas.height = SIZE.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  drawPattern(ctx, pattern, 0, 0, SIZE.w, SIZE.h, '#ffffff');
  const data = ctx.getImageData(0, 0, SIZE.w, SIZE.h).data;
  let filled = 0;
  let signature = '';
  for (let i = 3; i < data.length; i += 4) {
    const on = (data[i] as number) > 40;
    if (on) filled++;
    signature += on ? '1' : '0';
  }
  return { filled, signature };
}

afterEach(() => {
  document.documentElement.removeAttribute('data-palette');
  invalidateTheme();
});

describe('colour-blind safe colours: shapes and patterns', () => {
  it('every pattern but plain paints something, inside its box, and no two paint the same picture', () => {
    const seen = new Map<string, string>();
    for (const pattern of COLOR_PATTERNS) {
      const { filled, signature } = paint(pattern);
      if (pattern === 'plain') {
        expect(filled).toBe(0);
        continue;
      }
      expect(filled, pattern).toBeGreaterThan(20);
      expect(filled, `${pattern} is not a solid fill`).toBeLessThan(SIZE.w * SIZE.h * 0.7);
      const twin = seen.get(signature);
      expect(twin, `${pattern} looks like ${twin}`).toBeUndefined();
      seen.set(signature, pattern);
    }
    expect(seen.size).toBe(COLOR_PATTERNS.length - 1);
  });

  it('a pattern stays inside the rectangle it is given', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 60;
    canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    for (const pattern of COLOR_PATTERNS) drawPattern(ctx, pattern, 20, 10, 20, 10, '#ffffff');
    const data = ctx.getImageData(0, 0, 60, 40).data;
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 60; x++) {
        const inside = x >= 20 && x < 40 && y >= 10 && y < 20;
        if (!inside) expect(data[(y * 60 + x) * 4 + 3], `pixel ${x},${y}`).toBe(0);
      }
  });

  it('the selection mark paints a heavy outline and the corner triangle, not just a colour change', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 60;
    canvas.height = 30;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    drawSelectionMark(ctx, 0, 0, 60, 30, '#ffffff');
    const alphaAt = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3] as number;
    expect(alphaAt(30, 1), 'top edge').toBeGreaterThan(200);
    expect(alphaAt(30, 28), 'bottom edge').toBeGreaterThan(200);
    expect(alphaAt(1, 15), 'left edge').toBeGreaterThan(200);
    expect(alphaAt(2, 2), 'corner triangle').toBeGreaterThan(200);
    expect(alphaAt(30, 15), 'the middle stays clear').toBe(0);
  });

  it('the theme tells the canvases when the safe palette is on', () => {
    expect(readTheme().colorSafe).toBe(false);
    document.documentElement.dataset.palette = 'safe';
    invalidateTheme();
    expect(readTheme().colorSafe).toBe(true);
  });
});
