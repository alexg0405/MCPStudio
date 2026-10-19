/**
 * `npm run check` must run everything CI would: all five tsconfigs (through tsc -b's references), eslint, and every
 * vitest project. A project added to vite.config.ts that scripts/check.mjs doesn't run would silently never run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config';
import { binPath, nodeArgumentsForScript } from '../../scripts/lib/tools.mjs';

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

  it('type-checks all five tsconfigs and lints through the package scripts it calls', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toBe('node scripts/check.mjs');
    expect(pkg.scripts.typecheck).toBe('tsc -b');
    expect(pkg.scripts.lint).toMatch(/^eslint \./);
    const root = JSON.parse(read('tsconfig.json')) as { references: { path: string }[] };
    expect(root.references.map((r) => r.path).sort()).toEqual(
      ['./tsconfig.app.json', './tsconfig.core.json', './tsconfig.node.json', './tsconfig.sw.json', './tsconfig.worklet.json'].sort(),
    );
    const script = read('scripts/check.mjs');
    expect(script).toContain('scripts.typecheck');
    expect(script).toContain('scripts.lint');
  });

  it('starts every tool with Node itself, never through npm or a shell (Windows cannot start a .cmd that way)', () => {
    for (const file of ['scripts/check.mjs', 'scripts/test-perf.mjs']) {
      const script = read(file);
      expect(script, file).toContain('process.execPath');
      expect(script, file).not.toMatch(/shell:\s*true|npm\.cmd|'npm'|'npx'/);
    }
  });

  it('keeps the strict speed limits switch out of the package script (cmd.exe cannot read VAR=value command)', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:perf']).toBe('node scripts/test-perf.mjs');
    for (const [name, command] of Object.entries(pkg.scripts)) expect(command, name).not.toMatch(/^\w+=/);
    expect(read('scripts/test-perf.mjs')).toContain("VITE_PERF_STRICT: '1'");
  });
});

describe('running the tools from scripts', () => {
  it('finds the file of each tool the scripts start (tsc\u2019s has no extension, but is JavaScript too)', () => {
    for (const [pkg, bin] of [['typescript', 'tsc'], ['eslint', 'eslint'], ['vitest', 'vitest'], ['vite', 'vite']] as const) {
      const path = binPath(pkg, bin);
      expect(existsSync(path), path).toBe(true);
    }
  });

  it('turns a package script into Node arguments', () => {
    const args = nodeArgumentsForScript('eslint . --cache --cache-location node_modules/.cache/eslint/.eslintcache');
    expect(args[0]).toMatch(/eslint/);
    expect(args.slice(1)).toEqual(['.', '--cache', '--cache-location', 'node_modules/.cache/eslint/.eslintcache']);
    expect(() => nodeArgumentsForScript('rm -rf dist')).toThrow(/rm/);
  });
});
