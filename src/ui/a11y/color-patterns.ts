/**
 * Patterns that stand for colours, so a colour is never the only clue (Settings → Accessibility → colour-blind safe
 * colours). A clip's colour is the musician's choice and can be any hex colour, so it is sorted into one of eight hue
 * families, and each family has its own pattern. Two clips of the same family look alike to everyone; two clips of
 * different families differ in a way that does not need colour vision.
 */

/** The pattern each hue family is marked with, in order. The last one marks greys and near-black or near-white. */
export const COLOR_PATTERNS = ['backslash', 'dots', 'slash', 'bars', 'lines', 'cross', 'zigzag', 'plain'] as const;
export type ColorPattern = (typeof COLOR_PATTERNS)[number];

/** Below this saturation (0 to 1) a colour counts as grey. */
const GREY_SATURATION = 0.14;

/** Hue (0 to 360), saturation and value (both 0 to 1) of a `#rrggbb` colour; null when it is not one. */
export function hueOf(hex: string): { hue: number; saturation: number; value: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1] as string, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, saturation: max === 0 ? 0 : delta / max, value: max };
}

/** Where each hue family ends (degrees): red and orange, yellow, green, teal, blue, purple, pink, then red again. */
const FAMILY_EDGES = [45, 70, 165, 200, 260, 300, 345];

/**
 * The pattern that marks a colour: by hue family (red and orange, yellow, green, teal, blue, purple, pink), and plain for
 * greys. Not a colour name, and not exact: it only has to tell apart colours a colour-blind person would confuse.
 */
export function patternFor(hex: string): ColorPattern {
  const found = hueOf(hex);
  if (!found || found.saturation < GREY_SATURATION) return 'plain';
  const edgeIndex = FAMILY_EDGES.findIndex((edge) => found.hue < edge);
  const family = edgeIndex === -1 ? 0 : edgeIndex;
  return COLOR_PATTERNS[family] as ColorPattern;
}

/**
 * Draws `pattern` filling the rectangle (x, y, w, h) with lines or dots of `color`, one pixel to two pixels wide. The caller
 * clips to the shape it wants; nothing is allocated except the path of this call, which runs when a layer is redrawn, not
 * every frame.
 */
export function drawPattern(
  ctx: CanvasRenderingContext2D,
  pattern: ColorPattern,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  if (pattern === 'plain' || w <= 0 || h <= 0) return;
  const step = 4;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  if (pattern === 'dots') {
    for (let px = x + 2; px < x + w; px += step) for (let py = y + 2; py < y + h; py += step) ctx.rect(px - 0.75, py - 0.75, 1.5, 1.5);
    ctx.fill();
  } else if (pattern === 'bars') {
    for (let px = x + 1; px < x + w; px += step) ctx.rect(px - 0.5, y, 1.25, h);
    ctx.fill();
  } else if (pattern === 'lines') {
    for (let py = y + 1; py < y + h; py += step) ctx.rect(x, py - 0.5, w, 1.25);
    ctx.fill();
  } else if (pattern === 'zigzag') {
    for (let py = y + 2; py < y + h; py += step * 1.5) {
      ctx.moveTo(x, py);
      for (let px = x, up = true; px < x + w; px += step, up = !up) ctx.lineTo(px + step / 2, py + (up ? -1.5 : 1.5));
    }
    ctx.stroke();
  } else {
    drawStripes(ctx, pattern, x, y, w, h, pattern === 'cross' ? step * 2.5 : step * 1.5);
  }
  ctx.restore();
}

/** Diagonal stripes (slash or backslash) and the cross of both. */
function drawStripes(
  ctx: CanvasRenderingContext2D,
  pattern: 'backslash' | 'slash' | 'cross',
  x: number,
  y: number,
  w: number,
  h: number,
  step: number,
): void {
  const slash = pattern === 'slash' || pattern === 'cross';
  const backslash = pattern === 'backslash' || pattern === 'cross';
  for (let offset = -h; offset < w + h; offset += step) {
    if (slash) {
      ctx.moveTo(x + offset, y + h);
      ctx.lineTo(x + offset + h, y);
    }
    if (backslash) {
      ctx.moveTo(x + offset, y);
      ctx.lineTo(x + offset + h, y + h);
    }
  }
  ctx.stroke();
}
