/** Canvas helpers shared by timeline editors. */

/**
 * Theme colours read from CSS custom properties (canvases can't use var() directly). Every value is
 * resolved to a plain `rgba()` (tokens may be `color-mix()`), so `alpha()` and `mix()` work on them.
 */
export interface TimelineTheme {
  bg: string;
  bgAlt: string;
  bar: string;
  beat: string;
  step: string;
  /** Darkens (or, on light stone, greys) areas that are out of range: past the end, outside the scale. */
  shade: string;
  keyWhite: string;
  keyBlack: string;
  note: string;
  noteBorder: string;
  noteSelected: string;
  /** The lighter top edge of a note. */
  noteTop: string;
  ghost: string;
  playhead: string;
  loop: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentLight: string;
  accentGlow: string;
  surface: string;
  border: string;
  borderSoft: string;
  lineFaint: string;
  danger: string;
  select: string;
  led: string;
  ledOff: string;
  ledGlow: string;
  marker: string;
  /** Track headers (alternating rows), the ruler. */
  surface2: string;
  surface3: string;
  surfaceInset: string;
  /** Accent and selection tints (the loop range on the ruler, a rubber-band selection). */
  accentSoft: string;
  accentStrong: string;
  selectTint: string;
  sheen: string;
  /** Floating readouts drawn on a canvas (the value being dragged): glass and its text. */
  glass: string;
  /** Dark ink for text on light fills (clips, notes, flags). */
  onLight: string;
  /** Font family for canvas text. */
  font: string;
}

let cached: TimelineTheme | null = null;

// ---------------------------------------------------------------- colour maths

type RGBA = readonly [number, number, number, number];

const parsed = new Map<string, RGBA>();
let probe: CanvasRenderingContext2D | null | undefined;

function probeCtx(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = null;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true });
  }
  return probe;
}

/** Any CSS colour as [r, g, b, a] (0–255, alpha 0–1). Cached; theme changes clear the cache. */
export function rgbaOf(color: string): RGBA {
  const hit = parsed.get(color);
  if (hit) return hit;
  let out: RGBA = [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(color.trim());
  if (hex) {
    let h = hex[1] as string;
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h.slice(0, 6), 16);
    out = [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  } else if (fn) {
    const a = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    out = [Number(fn[1]), Number(fn[2]), Number(fn[3]), a];
  } else {
    // color-mix(), named colours, color(): let the canvas resolve it.
    const ctx = probeCtx();
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      out = [d[0] as number, d[1] as number, d[2] as number, (d[3] as number) / 255];
    }
  }
  if (parsed.size > 2000) parsed.clear();
  parsed.set(color, out);
  return out;
}

function css([r, g, b, a]: RGBA): string {
  const q = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
  return `rgba(${q(r)}, ${q(g)}, ${q(b)}, ${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`;
}

const derived = new Map<string, string>();

function memo(key: string, make: () => string): string {
  let v = derived.get(key);
  if (v === undefined) {
    if (derived.size > 4000) derived.clear();
    v = make();
    derived.set(key, v);
  }
  return v;
}

/** `color` with its alpha multiplied by `a` (cached, so it is cheap per frame). */
export function alpha(color: string, a: number): string {
  return memo(`a|${color}|${a}`, () => {
    const c = rgbaOf(color);
    return css([c[0], c[1], c[2], c[3] * a]);
  });
}

/** Like CSS `color-mix(in srgb, a t, b)`: `t` of `a`, the rest `b` (cached). */
export function mix(a: string, b: string, t: number): string {
  return memo(`m|${a}|${b}|${t}`, () => {
    const x = rgbaOf(a);
    const y = rgbaOf(b);
    const l = (i: number) => (x[i] as number) * t + (y[i] as number) * (1 - t);
    return css([l(0), l(1), l(2), l(3)]);
  });
}

/** Relative luminance (0 dark … 1 light), for picking ink on a fill. */
export function luminance(color: string): number {
  const [r, g, b] = rgbaOf(color);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Dark ink on light fills, light text on dark ones. */
export function inkOn(fill: string, theme: TimelineTheme): string {
  return memo(`i|${fill}`, () => (luminance(fill) > 0.28 ? theme.onLight : theme.text));
}

/** Rounded rectangle path (no-op radius on tiny boxes, so dense views stay cheap and crisp). */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  if (rr < 0.75) ctx.rect(x, y, w, h);
  else ctx.roundRect(x, y, w, h, rr);
}

// ---------------------------------------------------------------- reading the theme

export function readTheme(el: Element = document.documentElement): TimelineTheme {
  if (cached) return cached;
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => {
    const raw = s.getPropertyValue(name).trim() || fallback;
    return css(rgbaOf(raw));
  };
  const note = v('--ag-note', '#80c977');
  cached = {
    bg: v('--ag-grid-bg', '#262e34'),
    bgAlt: v('--ag-grid-bg-alt', '#2a3339'),
    bar: v('--ag-grid-bar', '#12171b'),
    beat: v('--ag-grid-beat', '#1b2126'),
    step: v('--ag-grid-step', '#222a30'),
    shade: v('--ag-grid-shade', 'rgba(0,0,0,0.3)'),
    keyWhite: v('--ag-key-white', '#d7dce0'),
    keyBlack: v('--ag-key-black', '#1c2125'),
    note,
    noteBorder: v('--ag-note-border', '#3d6b38'),
    noteSelected: v('--ag-note-selected', '#ff7b6e'),
    noteTop: v('--ag-note-top', 'rgba(255,255,255,0.35)'),
    ghost: v('--ag-ghost', 'rgba(170,190,205,0.18)'),
    playhead: v('--ag-playhead', '#ff9a3c'),
    loop: v('--ag-loop', 'rgba(255,154,60,0.18)'),
    text: v('--ag-text', '#d9dfe4'),
    textDim: v('--ag-text-dim', '#929ca5'),
    textFaint: v('--ag-text-faint', '#6a747c'),
    accent: v('--ag-accent', '#ff9a3c'),
    accentLight: v('--ag-accent-light', '#ffc58f'),
    accentGlow: v('--ag-accent-glow', 'rgba(255,154,60,0.45)'),
    surface: v('--ag-surface-1', '#2a3238'),
    border: v('--ag-border', '#12161a'),
    borderSoft: v('--ag-border-soft', '#3f4951'),
    lineFaint: v('--ag-line-faint', 'rgba(255,255,255,0.05)'),
    danger: v('--ag-danger', '#e5574d'),
    select: v('--ag-select', '#5aa4e8'),
    led: v('--ag-led', '#9fde5a'),
    ledOff: v('--ag-led-off', '#46532f'),
    ledGlow: v('--ag-led-glow', 'rgba(159,222,90,0.6)'),
    marker: v('--ag-marker', '#d9c25b'),
    surface2: v('--ag-surface-2', '#323b42'),
    surface3: v('--ag-surface-3', '#3c464e'),
    surfaceInset: v('--ag-surface-inset', '#1e2428'),
    accentSoft: v('--ag-accent-soft', 'rgba(255,154,60,0.18)'),
    accentStrong: v('--ag-accent-strong', '#e08a37'),
    selectTint: v('--ag-select-tint', 'rgba(90,164,232,0.16)'),
    sheen: v('--ag-sheen', 'rgba(255,255,255,0.025)'),
    glass: v('--ag-glass-strong', 'rgba(18,19,22,0.9)'),
    onLight: v('--ag-on-light', '#111214'),
    font: s.getPropertyValue('--ag-font').trim() || 'system-ui, sans-serif',
  };
  return cached;
}

const themeListeners = new Set<() => void>();
let version = 0;

/** Call after the theme changes: canvases read it again and redraw (see onThemeChange). */
export function invalidateTheme(): void {
  cached = null;
  parsed.clear();
  derived.clear();
  version++;
  for (const fn of themeListeners) fn();
}

/** Counts theme changes (for React canvases: put it in an effect's dependencies). */
export function themeVersion(): number {
  return version;
}

/** Redraw when the theme or accent color changes. */
export function onThemeChange(fn: () => void): () => void {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

/**
 * Sizes a canvas's backing store to its CSS size × devicePixelRatio and returns a context already
 * scaled so drawing uses CSS pixels.
 */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const BLACK = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(key: number): boolean {
  return BLACK.has(((key % 12) + 12) % 12);
}

/** Lightens/darkens a hex colour by `amount` (-1…1). */
export function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1] as string, 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    const t = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.round(Math.max(0, Math.min(255, t)));
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
