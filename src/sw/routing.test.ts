import { describe, expect, it } from 'vitest';
import {
  cacheNameFor,
  CACHE_PREFIX,
  isCacheableAsset,
  routeRequest,
  staleCaches,
  withIsolationHeaders,
  type RouteInput,
} from './routing';

const ORIGIN = 'http://localhost:5391';
const precached = new Set(['/index.html', '/assets/index-abc123.js', '/manifest.webmanifest', '/icons/icon-192.png']);

const route = (over: Partial<RouteInput> & { path: string }) =>
  routeRequest({ method: 'GET', mode: 'no-cors', origin: ORIGIN, precached, ...over, url: `${ORIGIN}${over.path}` });

describe('service worker routing', () => {
  it('page loads go network first, with the cached app as the fallback', () => {
    expect(route({ path: '/', mode: 'navigate' })).toBe('shell');
    expect(route({ path: '/?perf=piano', mode: 'navigate' })).toBe('shell');
    expect(route({ path: '/index.html', mode: 'navigate' })).toBe('shell');
  });

  it('precached files (hashed assets, icons, the manifest) come from the cache first', () => {
    expect(route({ path: '/assets/index-abc123.js' })).toBe('asset');
    expect(route({ path: '/manifest.webmanifest' })).toBe('asset');
    expect(route({ path: '/icons/icon-192.png' })).toBe('asset');
    // A worker or worklet module is fetched with its own request mode: same route.
    expect(route({ path: '/assets/limiter.worklet-xyz.js', mode: 'cors' })).toBe('asset');
  });

  it('never answers the server’s own endpoints, even for a page load', () => {
    for (const path of ['/api/ai/chat', '/api/ai/status', '/api/mcp/info', '/api/plugins/new', '/mcp', '/mcp/', '/__open-in-editor?file=x', '/@vite/client', '/node_modules/.vite/deps/react.js']) {
      expect(route({ path }), path).toBe('network');
      expect(route({ path, mode: 'navigate' }), `${path} (navigation)`).toBe('network');
    }
  });

  it('never touches anything but GET', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect(route({ path: '/assets/index-abc123.js', method })).toBe('network');
      expect(route({ path: '/', mode: 'navigate', method })).toBe('network');
    }
  });

  it('leaves other origins and unknown files to the network', () => {
    expect(routeRequest({ method: 'GET', mode: 'cors', origin: ORIGIN, precached, url: 'https://cdn.example.com/assets/index-abc123.js' })).toBe('network');
    expect(route({ path: '/some/user/file.wav' })).toBe('network');
    expect(route({ path: '/plugins/user-thing/index.ts' })).toBe('network');
  });

  it('keeps a lazy chunk under /assets/ that the list missed (a newer build) for offline use', () => {
    expect(route({ path: '/assets/PianoRoll-newhash.js', mode: 'cors' })).toBe('asset');
    expect(isCacheableAsset('/assets/PianoRoll-newhash.js', 200)).toBe(true);
    expect(isCacheableAsset('/assets/PianoRoll-newhash.js', 404)).toBe(false);
    expect(isCacheableAsset('/assets/x.js', 206)).toBe(false);
    expect(isCacheableAsset('/api/x', 200)).toBe(false);
  });
});

describe('service worker caches', () => {
  it('each build has its own cache, and only ours are ever deleted', () => {
    expect(cacheNameFor('abc123')).toBe(`${CACHE_PREFIX}abc123`);
    const names = [cacheNameFor('old1'), cacheNameFor('old2'), cacheNameFor('now'), 'agstudio-samples', 'some-other-app', 'workbox-precache'];
    expect(staleCaches(names, cacheNameFor('now'))).toEqual([cacheNameFor('old1'), cacheNameFor('old2')]);
    expect(staleCaches([cacheNameFor('now')], cacheNameFor('now'))).toEqual([]);
  });
});

describe('isolation headers', () => {
  it('puts COOP, COEP and CORP on what the worker serves, keeping the rest', () => {
    const out = withIsolationHeaders(new Headers({ 'content-type': 'text/javascript', 'cache-control': 'max-age=60' }));
    expect(out.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(out.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(out.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(out.get('content-type')).toBe('text/javascript');
    expect(out.get('cache-control')).toBe('max-age=60');
  });

  it('replaces weaker values from the server and does not change the original', () => {
    const original = new Headers({ 'Cross-Origin-Embedder-Policy': 'unsafe-none' });
    const out = withIsolationHeaders(original);
    expect(out.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(original.get('Cross-Origin-Embedder-Policy')).toBe('unsafe-none');
  });
});
