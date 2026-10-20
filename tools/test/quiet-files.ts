import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Finding the test files that hold "quiet machine" tests, for the two sequential test projects in `vite.config.ts`.
 *
 * Some tests only mean something when the machine is not shared with other tests: they need a live audio clock
 * (`realtime`), or they assert on speed, CPU cost or memory (`perf`). Such a test says so with a tag
 * (`it('…', { tags: ['realtime'] }, …)`, or the same options on a `describe`). Vitest only reads tags while running a
 * file, so to run exactly those files one after the other the config needs a list of them up front: this reads the
 * test files and picks the ones that mention a quiet-machine tag.
 */

/** The tags that put a test in the sequential stage (declared in `vite.config.ts`). */
export const QUIET_TAGS = ['perf', 'realtime'] as const;

/** Folders that hold tests, relative to the project folder. */
const TEST_FOLDERS = ['src', 'test', 'plugins'];

const TEST_FILE = /\.test\.tsx?$/;
/** `tags: ['perf']` or `tags: ["realtime", "x"]`, in the options of a test or a suite. */
const TAG_LIST = new RegExp(`tags:\\s*\\[[^\\]]*['"](?:${QUIET_TAGS.join('|')})['"]`);

/** The files a project runs: Node tests (`unit-timing`) and browser tests (`audio-realtime`), project-relative with `/`. */
export interface QuietFiles {
  node: string[];
  browser: string[];
}

function* walk(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('_')) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (TEST_FILE.test(entry.name)) yield path;
  }
}

/** True for the files the `audio` project runs (in a browser): `*.browser.test.*` and everything under `test/browser/`. */
function isBrowserTest(path: string): boolean {
  return /\.browser\.test\.tsx?$/.test(path) || path.startsWith('test/browser/');
}

/** The test files under `root` that carry a quiet-machine tag, split into the Node ones and the browser ones. */
export function findQuietFiles(root: string): QuietFiles {
  const found: QuietFiles = { node: [], browser: [] };
  for (const folder of TEST_FOLDERS) {
    let files: string[];
    try {
      files = [...walk(join(root, folder))];
    } catch {
      continue; // a folder that does not exist (a project without user plugins)
    }
    for (const file of files) {
      if (!TAG_LIST.test(readFileSync(file, 'utf8'))) continue;
      const path = relative(root, file).split(sep).join('/');
      (isBrowserTest(path) ? found.browser : found.node).push(path);
    }
  }
  found.node.sort();
  found.browser.sort();
  return found;
}
