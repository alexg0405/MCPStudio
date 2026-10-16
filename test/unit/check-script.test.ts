/**
 * `npm run check` must run everything CI would: all four tsconfigs (through tsc -b's references), eslint, and every
 * vitest project. A project added to vite.config.ts that scripts/check.mjs doesn't run would silently never run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('npm run check', () => {
  it('runs every vitest project', () => {
    const resolved = typeof config === 'function' ? config({ mode: 'test', command: 'serve' }) : config;
    const projects = ((resolved as { test?: { projects?: { test?: { name?: string } }[] } }).test?.projects ?? []).map(
      (p) => p.test?.name,
    );
    expect(projects.length).toBeGreaterThan(0);
    const script = read('scripts/check.mjs');
    const run = [...script.matchAll(/'--project',\s*'([\w-]+)'/g)].map((m) => m[1]);
    expect([...run].sort()).toEqual([...projects].sort());
  });

  it('type-checks all four tsconfigs and lints through the package scripts it calls', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toBe('node scripts/check.mjs');
    expect(pkg.scripts.typecheck).toBe('tsc -b');
    expect(pkg.scripts.lint).toMatch(/^eslint \./);
    const root = JSON.parse(read('tsconfig.json')) as { references: { path: string }[] };
    expect(root.references.map((r) => r.path).sort()).toEqual(
      ['./tsconfig.app.json', './tsconfig.core.json', './tsconfig.node.json', './tsconfig.worklet.json'].sort(),
    );
    const script = read('scripts/check.mjs');
    expect(script).toContain("'typecheck'");
    expect(script).toContain("'lint'");
  });
});
