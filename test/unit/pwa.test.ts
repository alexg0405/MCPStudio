/// <reference types="node" />
/**
 * The installable app's static parts, checked by hand since Lighthouse is not installed: what Chrome needs to offer
 * "Install AGstudio" (a manifest with name, icons, start_url, display; a service worker with a fetch handler), that
 * the icons really are the sizes the manifest says, and that the manifest agrees with the app (the file types it
 * registers, the colors of the theme tokens, the page that links it).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_FILE_EXTENSION, PROJECT_FILE_MIME } from '@core/io/project-file';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));
const text = (path: string) => read(path).toString('utf8');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  background_color: string;
  theme_color: string;
  icons: Icon[];
  file_handlers: { action: string; accept: Record<string, string[]>; launch_type?: string }[];
  launch_handler: { client_mode: string | string[] };
}
const manifest = JSON.parse(text('public/manifest.webmanifest')) as Manifest;

/** Width and height from a PNG's header (and that it is a PNG at all). */
function pngSize(path: string): { width: number; height: number } {
  const b = read(path);
  expect(b.subarray(0, 8).toString('hex'), `${path} is a PNG`).toBe('89504e470d0a1a0a');
  expect(b.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('web app manifest: installability', () => {
  it('has the fields Chrome requires', () => {
    expect(manifest.name).toBe('AGstudio');
    expect(manifest.short_name).toBe('AGstudio');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.id).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.display_override).toEqual(['window-controls-overlay', 'standalone']);
  });

  it('starts inside its scope', () => {
    expect(new URL(manifest.start_url, 'http://x/').pathname.startsWith(manifest.scope)).toBe(true);
  });

  it('has 192 and 512 px PNG icons, a maskable one, and the files are those sizes', () => {
    const png = manifest.icons.filter((i) => i.type === 'image/png');
    for (const size of [192, 512]) expect(png.some((i) => i.sizes === `${size}x${size}` && (i.purpose ?? 'any').includes('any')), `${size} any`).toBe(true);
    expect(png.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const icon of png) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(`public${icon.src}`), icon.src).toEqual({ width: w, height: h });
    }
    for (const icon of manifest.icons) expect(read(`public${icon.src}`).length, icon.src).toBeGreaterThan(100);
  });

  it('takes its colors from the theme tokens', () => {
    const tokens = text('src/ui/theme/tokens.css');
    const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)?.[1]?.toLowerCase();
    expect(manifest.background_color).toBe(token('ag-bg'));
    expect(manifest.theme_color).toBe(token('ag-surface-1'));
  });
});

describe('opening files with the app', () => {
  it('registers the project, chain, preset and rack files, one window for all of them', () => {
    const [handler] = manifest.file_handlers;
    expect(handler?.action).toBe('/');
    const extensions = Object.values(handler?.accept ?? {}).flat();
    expect(extensions.sort()).toEqual(['.agchain', '.agpreset', '.agrack', PROJECT_FILE_EXTENSION].sort());
    expect(handler?.accept[PROJECT_FILE_MIME]).toEqual([PROJECT_FILE_EXTENSION]);
    expect(handler?.launch_type).toBe('single-client');
  });

  it('brings a file opened while the app runs to the running window instead of opening another', () => {
    const mode = manifest.launch_handler.client_mode;
    expect(Array.isArray(mode) ? mode[0] : mode).toBe('focus-existing');
  });
});

describe('the page and the service worker', () => {
  const html = text('index.html');

  it('index.html links the manifest, the title-bar color and an Apple icon that exist', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toMatch(/<meta name="theme-color" content="#16171a"/);
    const apple = /rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(apple && read(`public${apple}`).length).toBeGreaterThan(100);
  });

  it('the service worker answers fetches, installs the precache and cleans up old versions', () => {
    const sw = text('src/sw/sw.ts');
    expect(sw).toMatch(/addEventListener\('fetch'/);
    expect(sw).toMatch(/addEventListener\('install'/);
    expect(sw).toMatch(/addEventListener\('activate'/);
    expect(sw).toContain('staleCaches');
    // An update waits for the musician (no skipWaiting of its own): only the page's message starts it.
    const code = sw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/skipWaiting/g)).toHaveLength(1);
    expect(code.indexOf('skipWaiting')).toBeGreaterThan(code.indexOf("addEventListener('message'"));
  });

  it('only production builds register it (development keeps hot reload untouched)', () => {
    const pwa = text('src/app/pwa/pwa.ts');
    expect(pwa).toContain('production: !import.meta.env.DEV');
    expect(pwa).toMatch(/if \(this\.env\.production\) void this\.register\(sw\);\s*else void this\.removeStaleWorker\(sw\);/);
  });

  it('the build script plugin is part of the Vite config', () => {
    expect(text('vite.config.ts')).toMatch(/pwaPrecache\(\{ entry: `\$\{root\}src\/sw\/sw\.ts` \}\)/);
  });
});
