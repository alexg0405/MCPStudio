import { envValue, pathsOf, type Host } from './host.ts';

/**
 * Where the AI command line tools (Claude Code, Codex) may be installed, in the order to try them. The dev server's
 * PATH is often shorter than the one in the user's own terminal (an app started from the Dock, the Start menu or a
 * shortcut), so the installers' usual folders are listed as well.
 */

/** The commands AGstudio looks for. */
export type CliName = 'claude' | 'codex';

/**
 * What Windows runs when the name has no extension, best first. `.exe` is a real program; `.cmd` is the shim `npm i -g`
 * writes. `.bat` and `.com` are rare but valid.
 */
export const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'] as const;

const hasWindowsExtension = (path: string) => WINDOWS_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));

/** The folders of the PATH (empty entries dropped; Windows lets an entry be wrapped in double quotes). */
export function pathFolders(host: Host): string[] {
  const separator = host.platform === 'win32' ? ';' : ':';
  return (envValue(host, 'PATH') ?? '')
    .split(separator)
    .map((folder) => (host.platform === 'win32' ? folder.trim().replace(/^"(.*)"$/, '$1') : folder))
    .filter(Boolean);
}

/** Every file name `name` can have in one folder: just `name` elsewhere, `name.exe`, `name.cmd`… on Windows. */
function fileNames(name: string, host: Host): string[] {
  return host.platform === 'win32' ? WINDOWS_EXTENSIONS.map((ext) => `${name}${ext}`) : [name];
}

/** `name` in every folder of the PATH. */
export function onPath(name: string, host: Host): string[] {
  const paths = pathsOf(host);
  return pathFolders(host).flatMap((folder) => fileNames(name, host).map((file) => paths.join(folder, file)));
}

/** Folders the installers use on Windows (`%APPDATA%` and `%LOCALAPPDATA%` fall back to their usual place). */
function windowsInstallFolders(host: Host): { native: string; others: string[] } {
  const paths = pathsOf(host);
  const appData = envValue(host, 'APPDATA') || paths.join(host.homeDir, 'AppData', 'Roaming');
  const localAppData = envValue(host, 'LOCALAPPDATA') || paths.join(host.homeDir, 'AppData', 'Local');
  return {
    // The native installers put the program here (Claude Code: irm https://claude.ai/install.ps1 | iex).
    native: paths.join(host.homeDir, '.local', 'bin'),
    others: [
      // `npm i -g` writes its .cmd shims here.
      paths.join(appData, 'npm'),
      // pnpm's global folder, WinGet's links to portable programs, and Scoop's shims.
      paths.join(localAppData, 'pnpm'),
      paths.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      paths.join(host.homeDir, 'scoop', 'shims'),
      paths.join(host.homeDir, '.npm-global'),
    ],
  };
}

/** An override typed by the user: as given, and (Windows, no extension) with the extensions a command can have. */
function overrideCandidates(override: string | undefined, host: Host): string[] {
  if (!override) return [];
  if (host.platform !== 'win32' || hasWindowsExtension(override)) return [override];
  return [override, ...WINDOWS_EXTENSIONS.map((ext) => `${override}${ext}`)];
}

/** The folders with `name` inside them, per platform. macOS and Linux keep the order they always had. */
function unixCandidates(name: CliName, host: Host): string[] {
  const paths = pathsOf(host);
  const home = host.homeDir;
  if (name === 'claude') {
    return [
      paths.join(home, '.local', 'bin', 'claude'),
      ...onPath('claude', host),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      paths.join(home, '.npm-global', 'bin', 'claude'),
    ];
  }
  return [
    ...onPath('codex', host),
    // The ChatGPT app for Mac carries its own copy.
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    paths.join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    paths.join(home, '.npm-global', 'bin', 'codex'),
  ];
}

/**
 * Windows: the install folders and the PATH. For Codex the PATH comes first (a copy the user chose to put on it);
 * for Claude Code the native installer's folder comes first, like on the other systems. Where the ChatGPT or Codex
 * desktop app keeps a bundled `codex.exe` on Windows is not known here: it is found through the PATH or through
 * `AGSTUDIO_CODEX_BIN`.
 */
function windowsCandidates(name: CliName, host: Host): string[] {
  const paths = pathsOf(host);
  const inFolders = (folders: string[]) =>
    folders.flatMap((folder) => fileNames(name, host).map((file) => paths.join(folder, file)));
  const { native, others } = windowsInstallFolders(host);
  if (name === 'claude') return [...inFolders([native]), ...onPath(name, host), ...inFolders(others)];
  return [...onPath(name, host), ...inFolders([native, ...others])];
}

/** The paths to try for `name`, first match wins: the override, then the PATH and the installers' folders. */
export function cliCandidates(name: CliName, host: Host, override?: string): string[] {
  const found = host.platform === 'win32' ? windowsCandidates(name, host) : unixCandidates(name, host);
  return [...overrideCandidates(override, host), ...found];
}
