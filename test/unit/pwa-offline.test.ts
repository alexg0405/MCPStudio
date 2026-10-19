/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * End to end for the installable app: the real production build (`vite build`, into a temporary folder), served by the
 * real `vite preview` on a free port, in headless Chrome. The service worker registers and takes over; the page is
 * cross-origin isolated; with the server stopped the app still starts from the cache, still isolated, while the
 * server's own endpoints (/api/*) are not answered from it; and a new build waits as "Update ready" until asked.
 *
 * Why not inside the browser test project: those pages come from the test runner's dev server, which has no production
 * build or service worker to test. A page served by the real preview server, in a browser of its own, is the thing
 * an installed app is made of.
 */
const run = promisify(execFile);
const root = process.cwd();
const viteBin = join(root, 'node_modules/vite/bin/vite.js');

let dir: string;
let out: string;
let preview: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page;
let base = '';
let skipReason = '';
let urls: string[] = [];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function listFiles(folder: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const e of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) found.push(...(await listFiles(folder, path)));
    else found.push(path);
  }
  return found;
}

const stopPreview = async () => {
  const child = preview;
  preview = null;
  if (!child) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
};

const startPreview = async (port: number) => {
  preview = spawn(process.execPath, [viteBin, 'preview', '--outDir', out, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/sw.js`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('vite preview did not start');
};

/** Past the welcome dialog (its backdrop would cover the update prompt). */
async function startApp(p: Page, welcome = false) {
  await p.waitForSelector('#root > *', { timeout: 60_000 });
  // The welcome dialog opens on the very first start only.
  if (welcome) await p.getByRole('button', { name: 'Start making music' }).click({ timeout: 30_000 });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ag-pwa-e2e-'));
  out = join(dir, 'dist');
  try {
    browser = await chromium.launch({ channel: process.env.AGSTUDIO_TEST_BROWSER || 'chrome', headless: true });
  } catch (e) {
    skipReason = `Chrome is not available: ${e instanceof Error ? e.message.split('\n')[0] : e}`;
    return;
  }
  await run(process.execPath, [viteBin, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    maxBuffer: 32 * 1024 * 1024,
  });
  urls = (await listFiles(out)).filter((f) => f !== 'sw.js' && !f.endsWith('.map')).map((f) => `/${f}`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startPreview(port);
  page = await (await browser.newContext()).newPage();
}, 300_000);

afterAll(async () => {
  await stopPreview();
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the installable app, from a production build', () => {
  const skip = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => (skipReason ? ctx.skip() : fn()), 180_000);

  skip('registers the service worker, takes over the page and stays cross-origin isolated', async () => {
    await page.goto(base);
    await startApp(page, true);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
    expect(scope).toBe(`${base}/`);
    // The manifest the page links is served and parses.
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href;
      return (await (await fetch(href)).json()) as { name: string };
    });
    expect(manifest.name).toBe('AGstudio');
  });

  skip('cached every file of the build under one versioned cache', async () => {
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names[0]!);
      return { names, keys: (await cache.keys()).map((r) => new URL(r.url).pathname) };
    });
    expect(cached.names).toHaveLength(1);
    expect(cached.names[0]).toMatch(/^agstudio-shell-[0-9a-f]{12}$/);
    expect(cached.keys.sort()).toEqual([...urls].sort());
  });

  skip('puts the isolation headers on what it serves', async () => {
    const headers = await page.evaluate(async () => {
      const res = await fetch('/index.html');
      return { coop: res.headers.get('cross-origin-opener-policy'), coep: res.headers.get('cross-origin-embedder-policy'), corp: res.headers.get('cross-origin-resource-policy') };
    });
    expect(headers).toEqual({ coop: 'same-origin', coep: 'require-corp', corp: 'same-origin' });
  });

  skip('starts offline with the server stopped: from the cache, still isolated, and never answering /api', async () => {
    await stopPreview();
    await page.reload();
    await startApp(page);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    // Every file of the build, lazy windows and audio worklets included, is served with no server.
    const statuses = await page.evaluate(async (list) => Promise.all(list.map(async (u) => (await fetch(u)).status)), urls);
    expect(statuses.every((s) => s === 200)).toBe(true);
    // The server's own endpoints are not the worker's: they fail like any request to a stopped server (and are not cached).
    const api = await page.evaluate(async () => {
      const get = await fetch('/api/ai/status').then((r) => `answered ${r.status}`, () => 'network error');
      const post = await fetch('/api/ai/chat', { method: 'POST', body: '{}' }).then((r) => `answered ${r.status}`, () => 'network error');
      const mcp = await fetch('/mcp', { method: 'POST', body: '{}' }).then((r) => `answered ${r.status}`, () => 'network error');
      return { get, post, mcp };
    });
    expect(api).toEqual({ get: 'network error', post: 'network error', mcp: 'network error' });
    const apiCached = await page.evaluate(async () => {
      for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) if (/\/(api|mcp)(\/|$)/.test(new URL(r.url).pathname)) return true;
      return false;
    });
    expect(apiCached).toBe(false);
  });

  skip('says "Update ready" for a new build and reloads into it only when asked', async () => {
    // The server is back, serving a new build (a different build id means a different cache).
    const sw = await readFile(join(out, 'sw.js'), 'utf8');
    const oldId = (await page.evaluate(async () => (await caches.keys())[0]!)).replace('agstudio-shell-', '');
    expect(sw).toContain(oldId);
    await writeFile(join(out, 'sw.js'), sw.replaceAll(oldId, 'ffffffffffff'));
    const port = Number(new URL(base).port);
    await startPreview(port);
    await page.evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true;
    });
    await page.evaluate(async () => void (await (await navigator.serviceWorker.getRegistration())?.update()));
    await page.getByText('Update ready').first().waitFor({ timeout: 60_000 });
    // Nothing reloaded by itself.
    expect(await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBe(true);
    expect((await page.evaluate(async () => caches.keys())).sort()).toEqual([`agstudio-shell-${oldId}`, 'agstudio-shell-ffffffffffff'].sort());
    await page.getByRole('button', { name: 'Reload' }).click();
    await page.waitForFunction(() => (window as unknown as { __stillHere?: boolean }).__stillHere === undefined, undefined, { timeout: 60_000 });
    await startApp(page);
    // The new version took over and the old cache is gone.
    await page.waitForFunction(async () => (await caches.keys()).join() === 'agstudio-shell-ffffffffffff', undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });
});
