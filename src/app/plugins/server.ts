/**
 * The dev server's plugin endpoints (`/api/plugins/*`, tools/ai/drafts.ts) as typed calls. Everything that reads or writes
 * the `plugins/` folder goes through here, so every feature says the same plain words when the server is missing (the
 * installed app has none) or refuses.
 */
import type { PluginFile } from '@core/plugin-bundle/rules';
import { devServerMissing } from '../local-server';

/** One plugin folder on disk, as the server lists it. */
export interface FolderInfo {
  folder: string;
  /** The plugin id the folder's code declares, or null. */
  id: string | null;
  files: { path: string; bytes: number }[];
  /** Milliseconds since 1970 of the newest file. */
  modified: number;
}

/** The plugin folders by place: loaded, switched off and deleted (recoverable). */
export interface PluginListing {
  installed: FolderInfo[];
  disabled: FolderInfo[];
  trash: FolderInfo[];
}

/** Why a call failed: no server, or the server said no (with the words to show). */
export class PluginServerError extends Error {
  constructor(
    message: string,
    /** 'no-server': nothing answered; 'refused': the server said no (see `status`); 'failed': anything else. */
    readonly kind: 'no-server' | 'refused' | 'failed',
    readonly status = 0,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** What a feature is called when the server is missing: "Sharing plugins needs…". */
async function call<T>(fetchImpl: Fetch, path: string, body: unknown, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/plugins/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agstudio': '1' },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new PluginServerError(devServerMissing(what), 'no-server');
  }
  // The production server (`agstudio --app`, the installed app) has nothing behind /api/plugins.
  if (res.status === 404 && !(await isJson(res))) throw new PluginServerError(devServerMissing(what), 'no-server', 404);
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!data) throw new PluginServerError(devServerMissing(what), 'no-server', res.status);
  if (!res.ok) throw new PluginServerError(data.error ?? `The server refused (${res.status}).`, 'refused', res.status);
  return data;
}

/** A 404 from the plugin endpoints has a JSON body with a reason; a 404 from a server without them does not. */
async function isJson(res: Response): Promise<boolean> {
  return (res.headers.get('content-type') ?? '').includes('json');
}

/** The calls, over a `fetch` (tests pass one that talks to the real handlers or a fake). */
export interface PluginServer {
  list(): Promise<PluginListing>;
  files(folder: string, where?: 'installed' | 'disabled' | 'trash'): Promise<{ files: PluginFile[]; skipped: string[] }>;
  /** Writes the files to a draft and checks them: the draft's folder and what is wrong with it. */
  draft(id: string, files: readonly PluginFile[]): Promise<{ folder: string; problems: string[] }>;
  /** Moves the draft into plugins/. With `keepExisting` it refuses to replace a plugin already there. */
  install(id: string, options?: { keepExisting?: boolean }): Promise<{ folder: string; replaced: boolean }>;
  discard(id: string): Promise<void>;
  /** The type check and the safety scan on an installed plugin, where it is. */
  check(folder: string): Promise<{ problems: string[] }>;
  trash(folder: string, where?: 'installed' | 'disabled'): Promise<{ entry: string }>;
  restore(entry: string): Promise<{ folder: string }>;
  disable(folder: string): Promise<{ folder: string }>;
  enable(folder: string): Promise<{ folder: string }>;
  openFolder(folder?: string): Promise<{ path: string }>;
}

/** The plugin server over `fetchImpl` (the page's fetch by default). */
export function pluginServer(fetchImpl: Fetch = (...args) => fetch(...args)): PluginServer {
  return {
    list: () => call(fetchImpl, 'list', {}, 'Managing plugins'),
    files: (folder, where = 'installed') => call(fetchImpl, 'files', { folder, where }, 'Sharing plugins'),
    draft: (id, files) => call(fetchImpl, 'draft', { id, files }, 'Installing plugins'),
    install: (id, options = {}) => call(fetchImpl, 'install', { id, ...options }, 'Installing plugins'),
    discard: async (id) => void (await call(fetchImpl, 'discard', { id }, 'Installing plugins')),
    check: (folder) => call(fetchImpl, 'check', { folder }, 'Checking plugins'),
    trash: (folder, where = 'installed') => call(fetchImpl, 'trash', { folder, where }, 'Managing plugins'),
    restore: (entry) => call(fetchImpl, 'restore', { entry }, 'Managing plugins'),
    disable: (folder) => call(fetchImpl, 'disable', { folder }, 'Managing plugins'),
    enable: (folder) => call(fetchImpl, 'enable', { folder }, 'Managing plugins'),
    openFolder: (folder) => call(fetchImpl, 'open-folder', folder ? { folder } : {}, 'Opening the plugins folder'),
  };
}
