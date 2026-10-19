// Running the project's command line tools (tsc, eslint, vitest, vite) from a script on any system.
//
// `npm`, `npx` and `node_modules/.bin/*` are `.cmd` files on Windows, which Node can only start through a shell
// (since Node 18.20 and 20.12 it refuses without one) that then re-reads every argument. A tool is just a JavaScript
// file, so the scripts start it with the Node that is already running them: no shell, no quoting, the same everywhere.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The AGstudio folder. */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The JavaScript file a package's command runs, read from its package.json (`bin` is a path or a name-to-path map). */
export function binPath(packageName, binName = packageName, root = repoRoot) {
  const folder = join(root, 'node_modules', packageName);
  const { bin } = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  const relative = typeof bin === 'string' ? bin : bin?.[binName];
  if (!relative) throw new Error(`${packageName} has no command called ${binName}`);
  return join(folder, relative);
}

/** The package each command of the npm scripts comes from (`tsc` is in the `typescript` package). */
const PACKAGE_OF = { tsc: 'typescript', eslint: 'eslint', vitest: 'vitest', vite: 'vite', prettier: 'prettier' };

/**
 * An npm script such as `eslint . --cache` as the Node arguments that run it: the tool's JavaScript file, then the
 * rest of the words. Only the plain `tool arguments` scripts are supported (no `&&`, no VAR=value), which is all
 * the ones this is used for are.
 */
export function nodeArgumentsForScript(script, root = repoRoot) {
  const [tool, ...rest] = script.trim().split(/\s+/);
  const packageName = PACKAGE_OF[tool];
  if (!packageName) throw new Error(`Don't know where the command "${tool}" lives (in the script "${script}")`);
  return [binPath(packageName, tool, root), ...rest];
}

/** The `scripts` of this project's package.json. */
export function packageScripts(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
}
