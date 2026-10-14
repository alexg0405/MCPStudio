/** Canvas helpers shared by timeline editors. */

/** Theme colours read from CSS custom properties (canvases can't use var() directly). */
export interface TimelineTheme {
  bg: string;
  bgAlt: string;
  bar: string;
  beat: string;
  step: string;
  keyWhite: string;
  keyBlack: string;
  note: string;
  noteBorder: string;
  noteSelected: string;
  ghost: string;
  playhead: string;
  loop: string;
  text: string;
  textDim: string;
  accent: string;
  surface: string;
  border: string;
  danger: string;
  select: string;
  led: string;
  ledOff: string;
  marker: string;
  /** Track headers (alternating rows). */
  surface2: string;
  surface3: string;
  /** Accent and selection tints (the loop range on the ruler, a rubber-band selection). */
  accentSoft: string;
  accentStrong: string;
  selectTint: string;
  sheen: string;
  /** Font family for canvas text. */
  font: string;
}

let cached: TimelineTheme | null = null;

export function readTheme(el: Element = document.documentElement): TimelineTheme {
  if (cached) return cached;
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  cached = {
    bg: v('--ag-grid-bg', '#262e34'),
    bgAlt: v('--ag-grid-bg-alt', '#2a3339'),
    bar: v('--ag-grid-bar', '#12171b'),
    beat: v('--ag-grid-beat', '#1b2126'),
    step: v('--ag-grid-step', '#222a30'),
    keyWhite: v('--ag-key-white', '#d7dce0'),
    keyBlack: v('--ag-key-black', '#1c2125'),
    note: v('--ag-note', '#80c977'),
    noteBorder: v('--ag-note-border', '#3d6b38'),
    noteSelected: v('--ag-note-selected', '#ff7b6e'),
    ghost: v('--ag-ghost', 'rgba(170,190,205,0.18)'),
    playhead: v('--ag-playhead', '#ff9a3c'),
    loop: v('--ag-loop', 'rgba(255,154,60,0.18)'),
    text: v('--ag-text', '#d9dfe4'),
    textDim: v('--ag-text-dim', '#929ca5'),
    accent: v('--ag-accent', '#ff9a3c'),
    surface: v('--ag-surface-1', '#2a3238'),
    border: v('--ag-border', '#12161a'),
    danger: v('--ag-danger', '#e5574d'),
    select: v('--ag-select', '#5aa4e8'),
    led: v('--ag-led', '#9fde5a'),
    ledOff: v('--ag-led-off', '#46532f'),
    marker: v('--ag-marker', '#d9c25b'),
    surface2: v('--ag-surface-2', '#323b42'),
    surface3: v('--ag-surface-3', '#3c464e'),
    accentSoft: v('--ag-accent-soft', 'rgba(255,154,60,0.18)'),
    accentStrong: v('--ag-accent-strong', '#e08a37'),
    selectTint: v('--ag-select-tint', 'rgba(90,164,232,0.16)'),
    sheen: v('--ag-sheen', 'rgba(255,255,255,0.025)'),
    font: v('--ag-font', 'system-ui, sans-serif'),
  };
  return cached;
}

const themeListeners = new Set<() => void>();
let version = 0;

/** Call after the theme changes: canvases read it again and redraw (see onThemeChange). */
export function invalidateTheme(): void {
  cached = null;
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
