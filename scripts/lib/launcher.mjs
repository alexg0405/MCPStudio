// The parts of the `agstudio` launcher that depend on the operating system, as plain functions that take the
// platform as an argument (so tests can check Windows, macOS and Linux on any machine). scripts/agstudio.mjs
// uses them. Node built-ins only: this file runs before anything is installed.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join, posix, win32 } from 'node:path';

/** The ports of the dev server and of the production build (`--app`), unless $PORT / $APP_PORT say otherwise. */
export const DEV_PORT = 5390;
export const APP_PORT = 5391;

/**
 * Reads the command line. Returns `{ mode: 'dev' | 'app' | 'help' }`, or `{ error }` with the offending word.
 * `--app` (or `app`) serves the production build, `-h` / `--help` prints the usage.
 */
export function parseArguments(argv) {
  let mode = 'dev';
  for (const word of argv) {
    if (word === '--app' || word === 'app') mode = 'app';
    else if (word === '-h' || word === '--help') return { mode: 'help' };
    else return { error: word };
  }
  return { mode };
}

/** The port to serve on: `$APP_PORT` or 5391 for `--app`, `$PORT` or 5390 for the dev server. */
export function portFor(mode, env) {
  const chosen = mode === 'app' ? env.APP_PORT : env.PORT;
  return chosen || String(mode === 'app' ? APP_PORT : DEV_PORT);
}

/**
 * The program and arguments that open a web address (or a file, such as a shortcut) with the system's default handler:
 * `open` on macOS, `cmd /c start` on Windows (the empty "" is the window title `start` insists on), `xdg-open` elsewhere.
 */
export function openCommand(platform, target) {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/c', 'start', '', target] };
  return { command: 'xdg-open', args: [target] };
}

/**
 * `cmd /c start` hands its text to cmd, where these characters would end or change the command. A web address built
 * from a port never has them; a folder name rarely does. When one does, that target is not opened.
 */
export function isSafeForCmd(target) {
  return !/[&|<>^%"]/.test(target);
}

/**
 * The installed AGstudio app (Chrome's or Edge's "Install as app"), if there is one to open by itself.
 * macOS: the app bundle Chrome writes. Windows: the Start menu shortcut Chrome or Edge writes. Linux: none (the browser
 * tab is opened, with the way to install).
 * `exists` is `fs.existsSync`, or a stand-in in tests.
 */
export function installedAppPath({ platform, env, homeDir, exists }) {
  if (platform === 'darwin') {
    const bundle = posix.join(homeDir, 'Applications', 'Chrome Apps.localized', 'AGstudio.app');
    return exists(bundle) ? bundle : null;
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || win32.join(homeDir, 'AppData', 'Roaming');
    const programs = win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcuts = [
      win32.join(programs, 'Chrome Apps', 'AGstudio.lnk'),
      win32.join(programs, 'AGstudio.lnk'),
      win32.join(programs, 'Edge Apps', 'AGstudio.lnk'),
    ];
    return shortcuts.find((path) => exists(path)) ?? null;
  }
  return null;
}

/** The folders and files the production build is made from: when any is newer than the build, it is built again. */
const BUILD_INPUTS = ['src', 'plugins', 'public', 'templates', 'tools', 'index.html', 'vite.config.ts', 'package.json'];

/** True when `path` (a file, or a folder searched through) holds something modified after `sinceMs`. */
function hasNewerFile(path, sinceMs) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return false;
  }
  if (!info.isDirectory()) return info.mtimeMs > sinceMs;
  return readdirSync(path).some((name) => hasNewerFile(join(path, name), sinceMs));
}

/** Whether `dist/` is missing or older than the code it is built from. */
export function isBuildStale(repo) {
  const marker = join(repo, 'dist', 'sw.js');
  if (!existsSync(marker)) return true;
  const builtAt = statSync(marker).mtimeMs;
  return BUILD_INPUTS.some((name) => hasNewerFile(join(repo, name), builtAt));
}

/**
 * How to run `npm` without a shell: Node's own `npm-cli.js` (next to the running Node on Windows, in `../lib` on
 * macOS and Linux), or the one npm tells scripts about in `npm_execpath`. Null when it cannot be found; the caller
 * then falls back to the `npm` command on the PATH.
 */
export function npmCliPath({ platform, execPath, env, exists }) {
  const paths = platform === 'win32' ? win32 : posix;
  const nodeFolder = paths.dirname(execPath);
  const candidates = [
    env.npm_execpath,
    paths.join(nodeFolder, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    paths.join(nodeFolder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((path) => path && /npm-cli\.c?js$/.test(path) && exists(path)) ?? null;
}

/** `PATH` with the running Node's folder first, so the programs Vite starts find the same Node. */
export function pathWithNode(execPath, env) {
  return `${dirname(execPath)}${delimiter}${env.PATH ?? env.Path ?? ''}`;
}
