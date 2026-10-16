import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The access token AI apps present to the MCP endpoint. Generated once and kept in a git-ignored
 * file (`.agstudio/mcp-token`, readable by this user only), so setup commands keep working across
 * restarts. Regenerating it disconnects every app that had the old one.
 */
export const newToken = (): string => `agmcp_${randomBytes(32).toString('base64url')}`;

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
    if (existsSync(this.file)) chmodSync(this.file, 0o600);
    return (this.cached = token);
  }
}
