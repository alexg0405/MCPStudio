/// <reference types="node" />
/**
 * The production build minifies CSS with lightningcss, which drops the standard property when a rule lists it
 * BEFORE its `-webkit-` twin (`backdrop-filter` then `-webkit-backdrop-filter` came out as the prefixed one only).
 * Chrome ignores the prefixed `backdrop-filter`, so every menu, dialog and tooltip lost its glass blur in a built
 * app, and submenus (placed relative to the blur's containing block) opened in the wrong place. Write the
 * prefixed line first; this test minifies every stylesheet the way the build does and checks nothing is lost.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { transform } from 'lightningcss';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

describe('minified CSS keeps the standard property next to its -webkit- twin', () => {
  const props = ['backdrop-filter', 'user-select', 'appearance', 'background-clip', 'line-clamp', 'box-orient'];
  for (const file of cssFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!/-webkit-/.test(source)) continue;
    it(file.slice(SRC.length + 1), () => {
      const out = transform({ filename: file, code: Buffer.from(source), minify: true }).code.toString();
      for (const prop of props) {
        // Declarations of the standard property in the source (line starts) and in the output (after { or ;).
        const wanted = count(source, new RegExp(`^\\s*${prop}\\s*:`, 'gm'));
        const kept = count(out, new RegExp(`[{;]${prop}:`, 'g'));
        expect(kept, `${prop} in ${file}`).toBeGreaterThanOrEqual(wanted);
      }
    });
  }
});
