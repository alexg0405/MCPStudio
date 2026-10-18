/**
 * The decisions of the service worker (sw.ts), as pure functions so Node tests can cover them: which requests it
 * answers, which strategy each gets, the cache names, and the isolation headers it puts on what it serves.
 * No globals besides URL and Headers: this file is imported by the worker and by the tests.
 */

/** Cache names start with this; the rest is the build id, so each version has its own cache. */
export const CACHE_PREFIX = 'agstudio-shell-';

/** The page every navigation gets (the app is one page). */
export const SHELL_URL = '/index.html';

/** The message the page sends a waiting worker to take over (after the musician chose to reload). */
export const SKIP_WAITING_MESSAGE = 'agstudio:skip-waiting';

export const cacheNameFor = (buildId: string): string => `${CACHE_PREFIX}${buildId}`;

/** Caches of other versions (and only ours): what the worker deletes when it activates. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current);
}

/**
 * What to do with a request:
 * - `shell`: a page load. The network first (so a new version arrives as soon as the server has it), the cached
 *   page when the server cannot be reached.
 * - `asset`: something the build precached (hashed scripts and styles, icons, the manifest) or any file under
 *   /assets/. The cache first: a file whose name has a hash never changes, and each version's cache holds exactly
 *   its own files.
 * - `network`: not the worker's business. The browser's normal network path (nothing cached, nothing re-served).
 */
export type Route = 'shell' | 'asset' | 'network';

/** Paths the server answers itself (AI, MCP, plugin builder, dev tooling): never served from a cache. */
const SERVER_ONLY = /^\/(api|mcp|@vite|@fs|@id|@react-refresh|node_modules)(\/|$)|^\/__/;

export interface RouteInput {
  method: string;
  url: string;
  /** `request.mode` */
  mode: string;
  /** The worker's own origin. */
  origin: string;
  /** Paths of the precached files (`/assets/x-abc.js`). */
  precached: ReadonlySet<string>;
}

export function routeRequest(input: RouteInput): Route {
  if (input.method !== 'GET') return 'network';
  const url = new URL(input.url);
  if (url.origin !== input.origin) return 'network';
  if (SERVER_ONLY.test(url.pathname)) return 'network';
  if (input.mode === 'navigate') return 'shell';
  // Hashed files under /assets/ that the list missed (a lazy chunk of a newer build) are cached when first fetched.
  if (input.precached.has(url.pathname) || url.pathname.startsWith('/assets/')) return 'asset';
  return 'network';
}

/** Worker scripts, documents and scripts under cross-origin isolation need these on every response. */
const ISOLATION: ReadonlyArray<readonly [string, string]> = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  // Everything the worker serves is the app's own: other documents of the app may embed it.
  ['Cross-Origin-Resource-Policy', 'same-origin'],
];

/** The response's headers plus the isolation headers (the page stays cross-origin isolated when served from the cache). */
export function withIsolationHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const [name, value] of ISOLATION) out.set(name, value);
  return out;
}

/** Should a runtime-fetched asset (a precache miss under /assets/) be kept for offline use? */
export function isCacheableAsset(pathname: string, status: number): boolean {
  return status === 200 && pathname.startsWith('/assets/');
}
