// The host theme for canvases: CSS can use var(--ag-…) directly, a canvas can't.

/** Theme colours as CSS colour strings (ready for `ctx.fillStyle`), read from the host's tokens. */
export interface ThemeColors {
  /** The accent (brushed gold by default): values, curves, what is active. */
  accent: string;
  /** A lighter accent, for thin lines on dark wells. */
  accentLight: string;
  text: string;
  textDim: string;
  textFaint: string;
  /** Hairlines: grid lines, separators. */
  line: string;
  /** A slightly stronger hairline: the 0 dB line, bar lines. */
  lineStrong: string;
  /** The window, a panel, an inset well (displays, graphs). */
  surface: string;
  panel: string;
  well: string;
  /** The selection colour (soft steel blue): a second trace, the "other" channel. */
  select: string;
  danger: string;
  warning: string;
  led: string;
  meterLo: string;
  meterMid: string;
  meterHi: string;
  /** Text on an accent fill. */
  onAccent: string;
  /** Text on a light fill (a lit LED, a coloured handle). */
  onLight: string;
  font: string;
  monoFont: string;
  /** Eight distinct colours that sit well on stone (EQ bands, layers, voices). */
  palette: readonly string[];
}

let cached: ThemeColors | null = null;
let cachedKey = '';

/**
 * The host theme's colours. Cheap to call every frame: it reads the tokens again only when the
 * theme or accent changes (the host marks them on <html>), so canvases follow theme switches.
 *
 * ```ts
 * useFrame(() => {
 *   const t = themeColors();
 *   ctx.strokeStyle = t.accent;
 * });
 * ```
 */
export function themeColors(): ThemeColors {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const key = root ? `${root.getAttribute('data-theme') ?? ''}|${root.getAttribute('data-accent') ?? ''}` : '';
  if (cached && key === cachedKey) return cached;
  const s = root ? getComputedStyle(root) : null;
  const v = (name: string, fallback: string) => s?.getPropertyValue(name).trim() || fallback;
  cachedKey = key;
  cached = {
    accent: v('--ag-accent', '#c9a45c'),
    accentLight: v('--ag-accent-light', '#e2cfa6'),
    text: v('--ag-text', '#ecebe6'),
    textDim: v('--ag-text-dim', '#a6a39b'),
    textFaint: v('--ag-text-faint', '#6f6c66'),
    line: v('--ag-line-faint', 'rgba(255, 255, 255, 0.05)'),
    lineStrong: v('--ag-line-strong', 'rgba(255, 255, 255, 0.12)'),
    surface: v('--ag-surface-1', '#16171a'),
    panel: v('--ag-surface-2', '#1c1d21'),
    well: v('--ag-surface-inset', '#0e0f11'),
    select: v('--ag-select', '#8eb4e3'),
    danger: v('--ag-danger', '#e0675a'),
    warning: v('--ag-warning', '#d6b04f'),
    led: v('--ag-led', '#9fd38f'),
    meterLo: v('--ag-meter-lo', '#8fcf86'),
    meterMid: v('--ag-meter-mid', '#d9bf5f'),
    meterHi: v('--ag-meter-hi', '#e0675a'),
    onAccent: v('--ag-on-accent', '#17130b'),
    onLight: v('--ag-on-light', '#111214'),
    font: v('--ag-font', 'system-ui, sans-serif'),
    monoFont: v('--ag-font-mono', 'ui-monospace, monospace'),
    palette: [
      v('--ag-palette-1', '#d98a7e'),
      v('--ag-palette-2', '#d9a066'),
      v('--ag-palette-3', '#d6c06f'),
      v('--ag-palette-4', '#9cc48a'),
      v('--ag-palette-5', '#7fc1b3'),
      v('--ag-palette-6', '#8eb4e3'),
      v('--ag-palette-7', '#a99be0'),
      v('--ag-palette-8', '#d394bf'),
    ],
  };
  return cached;
}
