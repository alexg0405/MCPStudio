import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * What the helpers in tools/ need to know about the computer they run on. Passing it in (instead of reading
 * `process.platform` everywhere) lets the unit tests check the Windows behaviour on any machine.
 */
export interface Host {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The user's home folder (`C:\Users\name` on Windows). */
  homeDir: string;
  /** The Node that runs this server: used to run JavaScript commands without a shell. */
  nodePath: string;
}

/** The computer this server really runs on. */
export function currentHost(): Host {
  return { platform: process.platform, env: process.env, homeDir: homedir(), nodePath: process.execPath };
}

/** The path functions of the host's own operating system (backslashes on Windows, slashes elsewhere). */
export function pathsOf(host: Pick<Host, 'platform'>): typeof posix {
  return host.platform === 'win32' ? win32 : posix;
}

/**
 * An environment variable by name. Windows treats names case-insensitively (`Path`, `PATH`, `path`), but a copied
 * environment object (`{ ...process.env }`) is case-sensitive, so a plain lookup could miss it.
 */
export function envValue(host: Pick<Host, 'platform' | 'env'>, name: string): string | undefined {
  if (host.platform !== 'win32') return host.env[name];
  const wanted = name.toLowerCase();
  const key = Object.keys(host.env).find((k) => k.toLowerCase() === wanted);
  return key === undefined ? undefined : host.env[key];
}

/** A copy of the environment without these variables (matched case-insensitively on Windows). */
export function envWithout(host: Pick<Host, 'platform' | 'env'>, names: readonly string[]): NodeJS.ProcessEnv {
  const isWindows = host.platform === 'win32';
  const unwanted = new Set(isWindows ? names.map((n) => n.toLowerCase()) : names);
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host.env)) {
    if (!unwanted.has(isWindows ? key.toLowerCase() : key)) copy[key] = value;
  }
  return copy;
}
