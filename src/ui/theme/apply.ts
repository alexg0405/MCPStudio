import { invalidateTheme } from '../timeline/canvas';

/** The themes (themes.css) and accent colors, as the menus and Settings list them. */
export const THEMES = [
  { id: 'marble', label: 'Black marble', hint: 'Obsidian stone with faint veining, glass panels and brushed gold (the default)' },
  { id: 'carrara', label: 'White marble', hint: 'Carrara: warm white stone and graphite text, for bright rooms' },
  { id: 'classic', label: 'Classic', hint: 'The original look: slate grays, like FL Studio' },
  { id: 'midnight', label: 'Midnight', hint: 'Darker, nearly black: easy on the eyes at night' },
  { id: 'graphite', label: 'Graphite', hint: 'Neutral grays without the blue tint' },
  { id: 'light', label: 'Light', hint: 'Light surfaces and dark text, for bright rooms' },
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
  return THEMES.find((x) => x.id === t || x.label.toLowerCase() === t)?.id ??
    (t === 'dark' || t.includes('black') ? 'marble' : t.includes('white') || t.includes('carrara') ? 'carrara' : t.includes('slate') || t.includes('fl') ? 'classic' : t.includes('night') ? 'midnight' : t.includes('gray') || t.includes('grey') ? 'graphite' : t.includes('marble') ? 'marble' : undefined);
}

export function findAccent(name: string): AccentId | undefined {
  const t = name.trim().toLowerCase();
  return ACCENTS.find((x) => x.id === t || x.label.toLowerCase() === t || x.color === t)?.id ??
    (t === 'violet' ? 'purple' : t === 'brass' ? 'gold' : t === 'silver' ? 'champagne' : t.includes('rose') ? 'rose' : undefined);
}

let applied = '';

/** Puts the theme and accent on <html> (data-theme, data-accent) and has the canvases redraw. */
export function applyTheme(theme: string, accent: string): void {
  const t = findTheme(theme) ?? 'marble';
  const a = findAccent(accent) ?? 'gold';
  const key = `${t}/${a}`;
  if (key === applied || typeof document === 'undefined') return;
  applied = key;
  const root = document.documentElement;
  if (t === 'marble') delete root.dataset.theme;
  else root.dataset.theme = t;
  if (a === 'gold') delete root.dataset.accent;
  else root.dataset.accent = a;
  invalidateTheme();
}
