import { rename, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** A problem with a plugin request, with the HTTP status to answer with. */
export class DraftError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The folders plugins move between. `plugins/_*` is outside discovery, the type check, lint, tests and git. */
export interface PluginPaths {
  /** The project root: where `node_modules/typescript`, `tsconfig.base.json` and the templates are. */
  root: string;
  /** Installed plugins (`plugins/<folder>/`), loaded by discovery. */
  plugins: string;
  /** Checked drafts waiting to be installed. */
  drafts: string;
  /** What an install replaced (kept for recovery). */
  backup: string;
  /** What "Delete" removed: recoverable until emptied by hand. */
  trash: string;
  /** Switched off: not loaded, kept as it is. */
  disabled: string;
}

/** The plugin folders under `pluginsDir` (default: `<root>/plugins`; tests pass a temporary one). */
export function pluginPaths(root: string, pluginsDir: string = join(root, 'plugins')): PluginPaths {
  return {
    root,
    plugins: pluginsDir,
    drafts: join(pluginsDir, '_drafts'),
    backup: join(pluginsDir, '_backup'),
    trash: join(pluginsDir, '_trash'),
    disabled: join(pluginsDir, '_disabled'),
  };
}

/** A relative path with forward slashes (tsconfig files read `../` the same on every system; Windows' `relative` gives backslashes). */
export const withForwardSlashes = (path: string): string => path.split(sep).join('/');

/**
 * Errors that mean "something has this folder open for a moment" (Windows: the dev server's file watcher or a virus
 * scanner holds a handle on a folder that was just written). Elsewhere a rename does not hit them.
 */
const TRANSIENT_FOLDER_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_WAIT_MS = 120;

/** Moves a folder, trying again a few times when Windows reports it busy. `move` and `pause` are the system's, or stand-ins in tests. */
export async function renameFolder(
  from: string,
  to: string,
  move: (from: string, to: string) => Promise<void> = rename,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await move(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_FOLDER_ERRORS.has(code) || attempt >= RENAME_ATTEMPTS) throw e;
      await pause(RENAME_WAIT_MS * attempt);
    }
  }
}

/** Deletes a folder, trying again a few times when Windows reports it busy. */
export const removeFolder = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: RENAME_WAIT_MS });

/** True when something exists at the path. */
export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** "20260101T120000Z": a sortable time stamp for folder names. */
export const stampNow = (now: Date = new Date()): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
