import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The access token AI apps present to the MCP endpoint. Generated once and kept in a file that version control
 * ignores (`.agstudio/mcp-token`), so setup commands keep working across restarts. Regenerating it disconnects
 * every app that had the old one.
 *
 * On macOS and Linux the file is readable by this user only (mode 0600). Windows has no such mode bits: the file
 * is as private as the folder it is in, and a folder under your own user profile (where people keep their
 * projects) is already closed to other accounts by Windows' default permissions.
 */
export const newToken = (): string => `agmcp_${randomBytes(32).toString('base64url')}`;

/** Tightens an existing file to owner-only where the system supports it (a file system without permissions is not an error). */
function keepPrivate(file: string): void {
  try {
    if (existsSync(file)) chmodSync(file, 0o600);
  } catch {
    /* Windows, or a file system without permissions (FAT, some network and WSL mounts) */
  }
}

/**
 * Where the access token lives: `<root>/.agstudio/mcp-token`, or the file `AGSTUDIO_MCP_TOKEN_FILE` names (the tests use
 * it). The MCP endpoint and Studio's own look-ups (tools/ai) both ask here, so they always mean the same file.
 */
export const tokenFilePath = (root: string, override?: string): string =>
  override ?? process.env.AGSTUDIO_MCP_TOKEN_FILE ?? join(root, '.agstudio', 'mcp-token');

const VALID = /^agmcp_[A-Za-z0-9_-]{32,}$/;

export class TokenStore {
  private cached: string | null = null;
  constructor(private readonly file: string) {}

  get(): string {
    if (this.cached) return this.cached;
    try {
      const saved = readFileSync(this.file, 'utf8').trim();
      if (VALID.test(saved)) return (this.cached = saved);
    } catch {
      /* none yet */
    }
    return this.write(newToken());
  }

  regenerate(): string {
    return this.write(newToken());
  }

  private write(token: string): string {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, `${token}\n`, { mode: 0o600 });
    keepPrivate(this.file);
    return (this.cached = token);
  }
}

/** One store per token file, so the MCP endpoint and Studio's look-ups share one cached token and one creation of the file. */
const stores = new Map<string, TokenStore>();
export function sharedTokenStore(file: string): TokenStore {
  let store = stores.get(file);
  if (!store) stores.set(file, (store = new TokenStore(file)));
  return store;
}
