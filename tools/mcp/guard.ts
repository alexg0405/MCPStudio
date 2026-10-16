import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Who may talk to the MCP endpoint. Three checks, in this order, each with its own plain message:
 *  1. the connection comes from this computer (loopback address),
 *  2. the Host and Origin headers name this computer (a web page on another site that reaches
 *     localhost through DNS rebinding sends its own host name, and a browser always adds Origin),
 *  3. the request carries the token (`Authorization: Bearer …`, or `?token=` for clients that can
 *     only set a URL).
 */

export interface Access {
  /** `req.socket.remoteAddress`. */
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
  /** The request URL (path and query). */
  url: string;
}

export interface Denied {
  status: number;
  message: string;
  /** Sent as `WWW-Authenticate` on a 401. */
  challenge?: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `localhost`, `127.0.0.1` or `[::1]`, with or without a port. */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const m = /^(\[[0-9a-f:]+\]|[^:]+)(:\d{1,5})?$/i.exec(host.trim());
  return !!m && LOCAL_NAMES.has(m[1]!.toLowerCase()) && (m[2] === undefined || Number(m[2].slice(1)) <= 65535);
}

/** A missing Origin is fine (command-line clients send none); a present one must be a local page. */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.host);
  } catch {
    return false;
  }
}

export function tokenOf(a: Pick<Access, 'authorization' | 'url'>): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(a.authorization ?? '');
  if (m) return m[1];
  try {
    return new URL(a.url, 'http://localhost').searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Compares in constant time (over hashes, so lengths don't leak either). */
export function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** Null when the request may proceed; otherwise what to answer. */
export function checkAccess(a: Access, token: string): Denied | null {
  if (!isLoopbackAddress(a.remoteAddress))
    return { status: 403, message: 'AGstudio only talks to apps on this computer.' };
  if (!isLocalHost(a.host))
    return { status: 403, message: 'Use http://localhost to reach AGstudio (this host name is not allowed).' };
  if (!isLocalOrigin(a.origin)) return { status: 403, message: 'Web pages from other sites may not use AGstudio.' };
  if (!sameToken(tokenOf(a), token))
    return {
      status: 401,
      message:
        'AGstudio needs its access token. Copy it from Options → Settings → Connect AI apps (MCP) and send it as "Authorization: Bearer <token>".',
      challenge: 'Bearer realm="AGstudio"',
    };
  return null;
}

/** At most `limit` requests in any `windowMs`: a runaway client can't flood the app. */
export class RateLimit {
  private stamps: number[] = [];
  constructor(
    private readonly limit = 600,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this request is allowed (and counted). */
  take(): boolean {
    const t = this.now();
    while (this.stamps.length && (this.stamps[0] as number) <= t - this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(t);
    return true;
  }
}
