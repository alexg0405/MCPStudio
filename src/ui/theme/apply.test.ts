import { describe, expect, it } from 'vitest';
import { ACCENTS, findAccent, findTheme, THEMES } from './apply';

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

  it('has a block in themes.css for every theme and accent but the defaults', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('./themes.css', import.meta.url), 'utf8');
    for (const t of THEMES) if (t.id !== 'marble') expect(css).toContain(`[data-theme='${t.id}']`);
    for (const a of ACCENTS) if (a.id !== 'gold') expect(css).toContain(`[data-accent='${a.id}'] {\n  --ag-accent: ${a.color};`);
  });
});
