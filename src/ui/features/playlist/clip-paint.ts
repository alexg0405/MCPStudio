/**
 * How a clip looks: its colors derived from the pattern / channel color against the stone, and the
 * one vertical gradient that paints a whole clip (lighter top edge, title strip, the body as a soft
 * gradient, a faint inner shadow at the bottom) in a single fill. Everything is cached per color and
 * height and dropped when the theme changes, so drawing hundreds of clips stays cheap.
 */
import { alpha, luminance, mix, onThemeChange, type TimelineTheme } from '../../timeline/canvas';
import { CLIP_TITLE_HEIGHT } from './clip-geometry';

/** The colors a clip is drawn with, derived from its base color and the theme. */
export interface ClipPaint {
  /** The color as drawn against the stone (slightly desaturated). */
  tone: string;
  /** Title text and content (notes, waveform, curve): a light tint on dark stone, a deep one on light. */
  ink: string;
  /** The ▾ menu mark and other quiet marks on the title strip. */
  inkSoft: string;
  /** Mini notes, waveforms and curves in the body. */
  content: string;
  /** The translucent fill under an automation curve. */
  contentFill: string;
  /** A brighter edge for the clip under the pointer. */
  hoverEdge: string;
}

const paints = new Map<string, ClipPaint>();
const gradients = new Map<string, CanvasGradient>();
onThemeChange(() => {
  paints.clear();
  gradients.clear();
});

/** True for light stone (White marble, Light): clips then get deeper ink instead of a light tint. */
export function lightStone(theme: TimelineTheme): boolean {
  return luminance(theme.bg) > 0.45;
}

/** The colors for a clip of this base color (kept per color until the theme changes). */
export function clipPaint(base: string, theme: TimelineTheme): ClipPaint {
  let p = paints.get(base);
  if (p) return p;
  const light = lightStone(theme);
  const tone = mix(base, theme.surface, 0.8);
  // Ink leans to the theme's text: ivory on black stone, graphite on white.
  const toward = light ? theme.onLight : theme.text;
  const ink = mix(base, toward, light ? 0.32 : 0.18);
  const content = mix(base, toward, light ? 0.55 : 0.42);
  p = {
    tone,
    ink,
    inkSoft: alpha(ink, 0.55),
    content,
    contentFill: alpha(content, light ? 0.22 : 0.18),
    hoverEdge: alpha(toward, light ? 0.35 : 0.45),
  };
  if (paints.size > 300) paints.clear();
  paints.set(base, p);
  return p;
}

/**
 * The clip's fill, from y = 0 to `h` (draw it translated to the clip's top): a 1px lighter edge, the
 * title strip, then the body darkening a little toward a soft inner shadow at the bottom.
 */
export function clipGradient(
  ctx: CanvasRenderingContext2D,
  base: string,
  theme: TimelineTheme,
  h: number,
  selected: boolean,
): CanvasGradient {
  const key = `${base}|${h}|${selected ? 1 : 0}`;
  let g = gradients.get(key);
  if (g) return g;
  const light = lightStone(theme);
  const bg = theme.bg;
  // How much of the color the title and body carry (more on selected clips).
  const lift = selected ? 0.1 : 0;
  // On white stone more color is darker, so the lighter title strip carries less of it.
  const title = light ? mix(base, bg, 0.3 + lift) : mix(base, bg, 0.66 + lift);
  const bodyTop = light ? mix(base, bg, 0.4 + lift) : mix(base, bg, 0.48 + lift);
  const bodyBottom = light ? mix(base, bg, 0.48 + lift) : mix(base, bg, 0.36 + lift);
  const edge = light ? mix(base, theme.surface2, 0.35) : mix(base, theme.text, 0.6);
  const shadow = light ? mix(base, bg, 0.56 + lift) : mix(base, bg, 0.26 + lift);
  const t = Math.min(CLIP_TITLE_HEIGHT, h);
  const s = (y: number) => Math.max(0, Math.min(1, y / h));
  g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, edge);
  g.addColorStop(s(1), edge);
  g.addColorStop(s(1), title);
  g.addColorStop(s(t), title);
  if (h > t + 2) {
    g.addColorStop(s(t), bodyTop);
    g.addColorStop(s(Math.max(t, h - 5)), bodyBottom);
    g.addColorStop(1, shadow);
  }
  if (gradients.size > 600) gradients.clear();
  gradients.set(key, g);
  return g;
}
