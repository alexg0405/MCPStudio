/// <reference types="node" />
/**
 * The page paints its theme's background before the app script runs (index.html reads the saved theme):
 * the colors listed there must be the themes' own `--ag-bg`, or the page flashes another shade when the app starts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES } from '@ui/theme/apply';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = (
  readFileSync(new URL('../../src/ui/theme/themes.css', import.meta.url), 'utf8') +
  readFileSync(new URL('../../src/ui/theme/tokens.css', import.meta.url), 'utf8')
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The `--ag-bg` a theme ends up with: the last rule for its selector that sets it. */
function themeBg(id: string): string | undefined {
  let found: string | undefined;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1]!.split(',').map((s) => s.trim());
    const hit = id === 'marble' ? selectors.includes(':root') : selectors.some((s) => s === `:root[data-theme='${id}']`);
    const bg = /--ag-bg:\s*(#[0-9a-f]{6})/i.exec(rule[2]!);
    if (hit && bg) found = bg[1]!.toLowerCase();
  }
  return found;
}

describe('boot background', () => {
  const boot = /var boot = \{([^}]*)\}/.exec(html)?.[1] ?? '';
  const colors = Object.fromEntries(
    [...boot.matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]),
  );

  it.each(THEMES.filter((t) => t.id !== 'marble').map((t) => t.id))('index.html knows the %s theme background', (id) => {
    expect(themeBg(id)).toBeDefined();
    expect(colors[id]).toBe(themeBg(id));
  });

  it('the default page color is the default theme background', () => {
    expect(html).toContain(`var(--boot-bg, ${themeBg('marble')})`);
  });
});
