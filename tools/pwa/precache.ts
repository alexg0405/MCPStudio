import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';

/**
 * The installable app's offline support, at build time: after the build has written dist/, list every file the
 * app needs, then bundle src/sw/sw.ts into dist/sw.js with that list and an id of the build (no workbox).
 * The service worker precaches the list when it installs, so a new build means a new cache.
 */

export interface BuiltFile {
  /** Path from the output folder, `/`-separated ("assets/index-abc.js"). */
  path: string;
  bytes: Uint8Array;
}

/** What never goes into the cache: the worker itself, source maps and hidden files. */
export function isPrecached(path: string): boolean {
  const name = posix.basename(path);
  return path !== 'sw.js' && !path.endsWith('.map') && !name.startsWith('.');
}

/**
 * The precache list: the site-root paths of the files to keep (sorted), and a build id that changes whenever the
 * name or the content of any of them does (the new worker then installs and offers the update).
 */
export function precacheList(files: readonly BuiltFile[]): { urls: string[]; buildId: string } {
  const kept = files
    .filter((f) => isPrecached(f.path))
    .map((f) => ({ url: `/${f.path}`, hash: createHash('sha256').update(f.bytes).digest('hex') }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const id = createHash('sha256');
  for (const f of kept) id.update(`${f.url}\0${f.hash}\n`);
  return { urls: kept.map((f) => f.url), buildId: id.digest('hex').slice(0, 12) };
}

function readTree(dir: string, root = dir): BuiltFile[] {
  const out: BuiltFile[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readTree(full, root));
    else out.push({ path: relative(root, full).split(sep).join('/'), bytes: readFileSync(full) });
  }
  return out;
}

/** The Vite plugin (production builds): writes dist/sw.js once everything else is written. */
export function pwaPrecache(opts: { entry: string }): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'ag:pwa-precache',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      // Only the app build (not a library or SSR build someone runs with this config).
      if (config.build.ssr || config.build.lib) return;
      const outDir = resolve(config.root, config.build.outDir);
      const { urls, buildId } = precacheList(readTree(outDir));
      await build({
        configFile: false,
        root: config.root,
        logLevel: 'warn',
        publicDir: false,
        define: { __AG_PRECACHE__: JSON.stringify(urls), __AG_BUILD_ID__: JSON.stringify(buildId) },
        build: {
          outDir,
          emptyOutDir: false,
          minify: true,
          target: 'es2022',
          lib: { entry: opts.entry, formats: ['iife'], name: 'AgstudioServiceWorker', fileName: () => 'sw.js' },
        },
      });
    },
  };
}
