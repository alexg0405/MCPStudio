import { describe, expect, it } from 'vitest';
import { ACCENTS, applyTheme, effectiveAccent, findAccent, findTheme, THEMES } from './apply';

describe('themes', () => {
  it('finds a theme or accent by id, label or a loose name', () => {
    expect(findTheme('light')).toBe('light');
    expect(findTheme('Midnight')).toBe('midnight');
    expect(findTheme('night mode')).toBe('midnight');
    expect(findTheme('grey')).toBe('graphite');
    expect(findTheme('neon')).toBeUndefined();
    expect(findAccent('Purple')).toBe('purple');
    expect(findAccent('violet')).toBe('purple');
    expect(findAccent('#4da3ff')).toBe('blue');
    expect(findAccent('teal')).toBeUndefined();
    expect(findTheme('dark')).toBe('marble');
    expect(findTheme('white marble')).toBe('carrara');
    expect(findTheme('FL classic')).toBe('classic');
    expect(findAccent('brass')).toBe('gold');
  });

  it('shows the theme default accent until one is picked, and Gold counts once picked', () => {
    for (const t of ['classic', 'midnight', 'graphite', 'light', 'Light']) {
      expect(effectiveAccent(t, 'gold', false)).toBe('orange');
      expect(effectiveAccent(t, 'gold', true)).toBe('gold');
    }
    for (const t of ['marble', 'carrara', 'dark', 'white marble']) {
      expect(effectiveAccent(t, 'gold', false)).toBe('gold');
      expect(effectiveAccent(t, 'gold', true)).toBe('gold');
    }
    // Any other accent was a choice, stored as such, so it shows in every theme.
    expect(effectiveAccent('classic', 'blue', false)).toBe('blue');
    expect(effectiveAccent('marble', 'orange', false)).toBe('orange');
    // Unknown or missing values fall back to the defaults.
    expect(effectiveAccent('classic', 'teal', false)).toBe('orange');
    expect(effectiveAccent('marble', 'teal', true)).toBe('gold');
  });

  it('applyTheme is a no-op without a document (Node)', () => {
    expect(() => applyTheme('classic', 'gold', true)).not.toThrow();
  });

  it('has a block in themes.css for every theme and accent but the defaults', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');
    for (const t of THEMES) if (t.id !== 'marble') expect(css).toContain(`[data-theme='${t.id}']`);
    for (const a of ACCENTS) if (a.id !== 'gold') expect(css).toContain(`[data-accent='${a.id}'] {\n  --ag-accent: ${a.color};`);
  });
});
