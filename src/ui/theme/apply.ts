import { invalidateTheme } from '../timeline/canvas';

/** The themes (themes.css) and accent colors, as the menus and Settings list them. */
export const THEMES = [
  { id: 'marble', label: 'Black marble', hint: 'Obsidian stone with faint veining, glass panels and brushed gold (the default)' },
  { id: 'carrara', label: 'White marble', hint: 'Carrara: warm white stone and graphite text, for bright rooms' },
  { id: 'classic', label: 'Classic', hint: 'The original look: slate grays, like FL Studio' },
  { id: 'midnight', label: 'Midnight', hint: 'Darker, nearly black: easy on the eyes at night' },
  { id: 'graphite', label: 'Graphite', hint: 'Neutral grays without the blue tint' },
  { id: 'light', label: 'Light', hint: 'Light surfaces and dark text, for bright rooms' },
  { id: 'contrast', label: 'High contrast', hint: 'Black with white text, a yellow accent and white edges: the strongest contrast (ignores the accent color)' },
  { id: 'contrast-light', label: 'High contrast light', hint: 'White with black text, a blue accent and black edges: the strongest contrast on a light page (ignores the accent color)' },
] as const;

export const ACCENTS = [
  { id: 'gold', label: 'Gold', color: '#c9a45c' },
  { id: 'champagne', label: 'Champagne', color: '#cfc4ae' },
  { id: 'rose', label: 'Rose gold', color: '#d39a88' },
  { id: 'orange', label: 'Orange', color: '#ff9a3c' },
  { id: 'blue', label: 'Blue', color: '#4da3ff' },
  { id: 'green', label: 'Green', color: '#5cc96b' },
  { id: 'purple', label: 'Purple', color: '#a77bff' },
  { id: 'pink', label: 'Pink', color: '#ff6fae' },
  { id: 'yellow', label: 'Yellow', color: '#f2c94c' },
  { id: 'red', label: 'Red', color: '#ff5f56' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type AccentId = (typeof ACCENTS)[number]['id'];

/** A theme or accent named loosely ("Light", "night", "purple"), or undefined. */
export function findTheme(name: string): ThemeId | undefined {
  const t = name.trim().toLowerCase();
  const exact = THEMES.find((x) => x.id === t || x.label.toLowerCase() === t)?.id;
  if (exact) return exact;
  if (t.includes('contrast')) return t.includes('light') || t.includes('white') ? 'contrast-light' : 'contrast';
  return (t === 'dark' || t.includes('black') ? 'marble' : t.includes('white') || t.includes('carrara') ? 'carrara' : t.includes('slate') || t.includes('fl') ? 'classic' : t.includes('night') ? 'midnight' : t.includes('gray') || t.includes('grey') ? 'graphite' : t.includes('marble') ? 'marble' : undefined);
}

export function findAccent(name: string): AccentId | undefined {
  const t = name.trim().toLowerCase();
  return ACCENTS.find((x) => x.id === t || x.label.toLowerCase() === t || x.color === t)?.id ??
    (t === 'violet' ? 'purple' : t === 'brass' ? 'gold' : t === 'silver' ? 'champagne' : t.includes('rose') ? 'rose' : undefined);
}

const SLATE_THEMES: ReadonlySet<string> = new Set(['classic', 'midnight', 'graphite', 'light']);

/**
 * The accent a theme shows when the user has not picked one: orange on the slate themes, gold on the
 * rest. Only the accent's own default (gold) can be untouched, so `accentPicked` says whether a stored
 * gold was chosen.
 */
export function themeDefaultAccent(theme: string): AccentId {
  return SLATE_THEMES.has(findTheme(theme) ?? 'marble') ? 'orange' : 'gold';
}

/** The accent that really shows for these prefs. Gold only counts once picked; before that the theme's default. */
export function effectiveAccent(theme: string, accent: string, accentPicked: boolean): AccentId {
  const a = findAccent(accent) ?? 'gold';
  if (a !== 'gold' || accentPicked) return a;
  return themeDefaultAccent(theme);
}

let applied = '';

/**
 * Puts the theme and accent on <html> (data-theme, data-accent) and has the canvases redraw. The
 * theme's default accent leaves data-accent off (themes.css falls back to it); any picked accent,
 * Gold included, sets it.
 */
export function applyTheme(theme: string, accent: string, accentPicked = false): void {
  const t = findTheme(theme) ?? 'marble';
  const a = effectiveAccent(theme, accent, accentPicked);
  const key = `${t}/${a}/${accentPicked}`;
  if (key === applied || typeof document === 'undefined') return;
  applied = key;
  const root = document.documentElement;
  if (t === 'marble') delete root.dataset.theme;
  else root.dataset.theme = t;
  if (!accentPicked && a === themeDefaultAccent(t)) delete root.dataset.accent;
  else root.dataset.accent = a;
  invalidateTheme();
  // The installed app's title bar (and the browser's chrome on phones) takes the toolbar's color.
  const surface = getComputedStyle(root).getPropertyValue('--ag-surface-1').trim();
  if (/^#[0-9a-f]{6}$/i.test(surface)) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
}
