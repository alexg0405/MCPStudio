/// <reference lib="webworker" />
/**
 * AGstudio's service worker: it makes the installed app start without a server and keeps it cross-origin isolated
 * (SharedArrayBuffer, recording) when it answers from the cache. Production builds only: the page registers it
 * (src/app/pwa) and never in development, so the dev server's hot reload is untouched.
 *
 * The build (tools/pwa/precache.ts) bundles this file into dist/sw.js, with the list of files to keep. What it does with
 * a request is decided in routing.ts (tested in Node). It never touches /api/*, /mcp or anything but GET.
 */
import {
  cacheNameFor,
  isCacheableAsset,
  routeRequest,
  SHELL_URL,
  SKIP_WAITING_MESSAGE,
  staleCaches,
  withIsolationHeaders,
} from './routing';

declare const self: ServiceWorkerGlobalScope;
/** Replaced at build time: the files to keep (paths from the site root) and an id of this exact build. */
declare const __AG_PRECACHE__: readonly string[];
declare const __AG_BUILD_ID__: string;

const CACHE = cacheNameFor(__AG_BUILD_ID__);
const PRECACHED: ReadonlySet<string> = new Set(__AG_PRECACHE__);
/** How long a page load waits for the server before the cached app opens instead. */
const SHELL_NETWORK_MS = 4000;

/** The same response with the isolation headers (a Response's headers cannot be changed in place). */
function isolated(res: Response): Response {
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: withIsolationHeaders(res.headers) });
}

self.addEventListener('install', (event) => {
  // Every file or none: a half-filled cache must never become the active one. It waits (no skipWaiting here): the
  // page offers "Update ready - reload" and sends SKIP_WAITING_MESSAGE when the musician agrees.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        __AG_PRECACHE__.map(async (path) => {
          // `reload` skips the browser's HTTP cache: the files of this build, not a stale copy.
          const res = await fetch(new Request(path, { cache: 'reload' }));
          if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
          await cache.put(path, res);
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of staleCaches(await caches.keys(), CACHE)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === SKIP_WAITING_MESSAGE) void self.skipWaiting();
});

async function shell(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(SHELL_URL);
  try {
    // Network first, so a new build shows up as soon as the server has it. With a cached app to fall back on, a
    // server that hangs does not hold the window back for long.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), SHELL_NETWORK_MS));
    const res = await (cached ? Promise.race([fetch(request), timeout]) : fetch(request));
    return isolated(res);
  } catch (e) {
    if (cached) return isolated(cached);
    throw e;
  }
}

async function asset(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const path = new URL(request.url).pathname;
  const hit = await cache.match(path);
  if (hit) return isolated(hit);
  const res = await fetch(request);
  if (isCacheableAsset(path, res.status)) await cache.put(path, res.clone());
  return isolated(res);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const route = routeRequest({
    method: request.method,
    url: request.url,
    mode: request.mode,
    origin: self.location.origin,
    precached: PRECACHED,
  });
  if (route === 'network') return; // the browser's own network path
  event.respondWith(route === 'shell' ? shell(request) : asset(request));
});
