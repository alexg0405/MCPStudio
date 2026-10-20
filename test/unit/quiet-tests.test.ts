/**
 * The quiet-machine test stages: tests tagged `perf` or `realtime` leave the parallel projects and run one file at a time
 * (`vite.config.ts`, `scripts/lib/test-stages.mjs`). The files that hold them are found by reading the test files
 * (`tools/test/quiet-files.ts`), so a wrong match here would silently drop a test from every run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QUIET_STAGES, STAGES, vitestArguments } from '../../scripts/lib/test-stages.mjs';
import { findQuietFiles, QUIET_TAGS } from '../../tools/test/quiet-files';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project folder holding the given files (path → text). */
function projectWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agstudio-quiet-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const TAGGED = "it('x', { tags: ['perf'] }, () => {});";

describe('finding the files with quiet-machine tests', () => {
  it('splits them into Node tests and browser tests, by where they live', () => {
    const root = projectWith({
      'src/core/a.test.ts': TAGGED,
      'src/ui/b.browser.test.tsx': "describe('x', { tags: ['realtime'] }, () => {});",
      'test/browser/c.test.ts': 'it("x", { timeout: 5, tags: ["realtime", "other"] }, () => {});',
      'test/unit/d.test.ts': TAGGED,
      'plugins/mine/e.test.ts': TAGGED,
    });
    expect(findQuietFiles(root)).toEqual({
      node: ['plugins/mine/e.test.ts', 'src/core/a.test.ts', 'test/unit/d.test.ts'],
      browser: ['src/ui/b.browser.test.tsx', 'test/browser/c.test.ts'],
    });
  });

  it('skips files without a quiet tag, other tags, files that are not tests, node_modules and folders starting with _', () => {
    const root = projectWith({
      'src/a.test.ts': "it('x', () => {});",
      'src/b.test.ts': "it('x', { tags: ['slow'] }, () => {});",
      'src/c.ts': TAGGED,
      'src/node_modules/d.test.ts': TAGGED,
      'plugins/_drafts/e.test.ts': TAGGED,
    });
    expect(findQuietFiles(root)).toEqual({ node: [], browser: [] });
  });

  it('does not mind a project without a plugins folder', () => {
    expect(findQuietFiles(projectWith({ 'src/a.test.ts': TAGGED }))).toEqual({ node: ['src/a.test.ts'], browser: [] });
  });

  it('finds the real quiet tests, each file once, and every one of them exists', () => {
    const root = join(dirname(new URL(import.meta.url).pathname), '..', '..');
    const found = findQuietFiles(root);
    const all = [...found.node, ...found.browser];
    expect(new Set(all).size).toBe(all.length);
    expect(found.browser.length).toBeGreaterThan(5);
    expect(found.node.length).toBeGreaterThan(2);
    for (const file of all) {
      expect(existsSync(join(root, file)), file).toBe(true);
      expect(readFileSync(join(root, file), 'utf8'), file).toMatch(/tags:\s*\[/);
    }
    for (const file of found.browser) expect(file, 'a browser file in the Node project').toMatch(/browser/);
  });
});

describe('the test stages', () => {
  it('keep the quiet tests out of the parallel stages and run only them in the quiet ones', () => {
    for (const name of ['unit', 'audio'] as const) {
      const words = STAGES[name].tagsFilter;
      for (const tag of QUIET_TAGS) expect(words, name).toContain(`!${tag}`);
    }
    for (const name of QUIET_STAGES) {
      const words = STAGES[name as keyof typeof STAGES].tagsFilter;
      for (const tag of QUIET_TAGS) expect(words, name).toContain(tag);
      expect(words, name).not.toContain('!');
    }
  });

  it('give Vitest its project and tag expression as separate words, with extra arguments last', () => {
    expect(vitestArguments('audio-realtime', ['--reporter=dot'])).toEqual([
      'run',
      '--project',
      'audio-realtime',
      '--tags-filter',
      'perf || realtime',
      '--reporter=dot',
    ]);
    expect(vitestArguments('unit')).toEqual(['run', '--project', 'unit', '--tags-filter', '!perf && !realtime']);
    expect(() => vitestArguments('nope')).toThrow(/Unknown test stage/);
  });

  it('declare the tags in the Vitest config, which would reject a tag it does not know', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    for (const tag of QUIET_TAGS) expect(config).toContain(`name: '${tag}'`);
  });
});
