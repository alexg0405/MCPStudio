import { invalidateTheme } from '../timeline/canvas';

/** The themes (themes.css) and accent colors, as the menus and Settings list them. */
export const THEMES = [
  { id: 'dark', label: 'Dark', hint: 'The classic: slate grays, like FL Studio' },
  { id: 'midnight', label: 'Midnight', hint: 'Darker, nearly black: easy on the eyes at night' },
  { id: 'graphite', label: 'Graphite', hint: 'Neutral grays without the blue tint' },
  { id: 'light', label: 'Light', hint: 'Light surfaces and dark text, for bright rooms' },
] as const;

export const ACCENTS = [
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
    (t.includes('night') ? 'midnight' : t.includes('gray') || t.includes('grey') ? 'graphite' : undefined);
}

export function findAccent(name: string): AccentId | undefined {
  const t = name.trim().toLowerCase();
  return ACCENTS.find((x) => x.id === t || x.label.toLowerCase() === t || x.color === t)?.id ??
    (t === 'violet' ? 'purple' : t === 'gold' ? 'yellow' : undefined);
}

let applied = '';

/** Puts the theme and accent on <html> (data-theme, data-accent) and has the canvases redraw. */
export function applyTheme(theme: string, accent: string): void {
  const t = findTheme(theme) ?? 'dark';
  const a = findAccent(accent) ?? 'orange';
  const key = `${t}/${a}`;
  if (key === applied || typeof document === 'undefined') return;
  applied = key;
  const root = document.documentElement;
  if (t === 'dark') delete root.dataset.theme;
  else root.dataset.theme = t;
  if (a === 'orange') delete root.dataset.accent;
  else root.dataset.accent = a;
  invalidateTheme();
}
