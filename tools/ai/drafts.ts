import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Plugins the AI studio writes (the plugin builder). Dev server only.
 *
 *   POST /api/plugins/draft    { id, files: [{ path, content }] } → { folder, problems: string[] }
 *   POST /api/plugins/install  { id } → { folder, replaced: boolean }
 *   POST /api/plugins/discard  { id } → { folder }
 *
 * A draft goes to plugins/_drafts/<name>/ (discovery, the type check and lint skip folders starting
 * with "_") and is checked: file names and sizes, imports limited to the SDK, react and the draft's
 * own files, no network/storage/eval, then the TypeScript compiler. Install moves it to
 * plugins/<name>/ (an existing plugin there goes to plugins/_backup/ first), where hot reload picks
 * it up. Only same-origin requests with the `x-agstudio` header are served.
 */

const MAX_FILES = 8;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 512 * 1024;
const TSC_TIMEOUT_MS = 90_000;

export class DraftError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface DraftFile {
  path: string;
  content: string;
}

/** "user.tape-stop" → "tape-stop". Plugin ids the builder may write are `user.<name>`. */
export function draftFolder(id: unknown): string {
  if (typeof id !== 'string' || !/^user\.[a-z][a-z0-9-]{1,40}$/.test(id))
    throw new DraftError('The plugin id must look like "user.my-plugin" (lowercase letters, digits, dashes).');
  return id.slice('user.'.length);
}

/** Flat file names only: index.ts, params.ts, dsp.worklet.ts, kernel.ts, README.md… */
export function checkFiles(files: unknown): DraftFile[] {
  if (!Array.isArray(files) || files.length === 0) throw new DraftError('The draft has no files.');
  if (files.length > MAX_FILES) throw new DraftError(`A draft may have at most ${MAX_FILES} files.`);
  let total = 0;
  const seen = new Set<string>();
  const out: DraftFile[] = [];
  for (const f of files) {
    const path = (f as DraftFile | null)?.path;
    const content = (f as DraftFile | null)?.content;
    if (typeof path !== 'string' || typeof content !== 'string') throw new DraftError('Every file needs a path and text.');
    if (!/^[a-z0-9][a-z0-9_-]{0,48}(\.(worklet|kernel))?\.(ts|tsx|md)$/i.test(path) || /^tsconfig/i.test(path))
      throw new DraftError(`"${path}" is not an allowed file name (flat names ending in .ts, .tsx or .md).`);
    if (seen.has(path.toLowerCase())) throw new DraftError(`"${path}" appears twice.`);
    seen.add(path.toLowerCase());
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new DraftError(`"${path}" is too large (${Math.round(bytes / 1024)} KB).`);
    total += bytes;
    out.push({ path, content });
  }
  if (total > MAX_TOTAL_BYTES) throw new DraftError('The draft is too large.');
  if (!seen.has('index.ts') && !seen.has('index.tsx')) throw new DraftError('A plugin needs an index.ts (or index.tsx).');
  return out;
}

const MAIN_IMPORTS = /^(@agstudio\/sdk(\/(params|ui|notes|worklet|dsp))?|react|react\/jsx-runtime)$/;
const WORKLET_IMPORTS = /^@agstudio\/sdk\/(worklet|params)$/;
const LOCAL_IMPORT = /^\.\/[A-Za-z0-9_.-]+?(\.(ts|tsx))?(\?worker&url)?$/;

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bfetch\s*\(/, 'network access (fetch)'],
  [/\b(XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection)\b/, 'network access'],
  [/\bnavigator\s*\.\s*sendBeacon\b/, 'network access (sendBeacon)'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'eval / new Function'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\b(localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/, 'browser storage'],
  [/\bwindow\s*\.\s*open\s*\(|\bimportScripts\s*\(/, 'opening pages or scripts'],
];

/** Problems with what a file imports or uses (plugins are sound code: no network, storage or eval). */
export function scanSource(file: DraftFile): string[] {
  if (file.path.endsWith('.md')) return [];
  const problems: string[] = [];
  const worklet = /\.worklet\.ts$/.test(file.path);
  const specifiers = [
    ...file.content.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
    ...file.content.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1] as string);
  for (const spec of specifiers) {
    if (LOCAL_IMPORT.test(spec)) continue;
    if (worklet ? WORKLET_IMPORTS.test(spec) : MAIN_IMPORTS.test(spec)) continue;
    problems.push(
      `${file.path}: may not import "${spec}" (allowed: ${
        worklet ? '@agstudio/sdk/worklet, @agstudio/sdk/params' : '@agstudio/sdk, its sub-modules, react'
      } and the plugin's own files like './params')`,
    );
  }
  // Strings and comments can mention these words; code can't use them.
  const code = file.content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  for (const [re, what] of FORBIDDEN) if (re.test(code)) problems.push(`${file.path}: plugins may not use ${what}`);
  return problems;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(e) });
    });
  });
}

/** Type-checks the draft like the app does: main-thread files with the DOM, worklet files with the AudioWorklet scope. */
export async function typeCheck(root: string, dir: string): Promise<string[]> {
  const base = relative(dir, join(root, 'tsconfig.base.json'));
  const configs = {
    '.check-main.json': {
      extends: base,
      compilerOptions: { lib: ['ES2023', 'DOM', 'DOM.Iterable'], types: ['vite/client'], jsx: 'react-jsx', noEmit: true },
      include: ['./*.ts', './*.tsx'],
      exclude: ['./*.worklet.ts'],
    },
    '.check-worklet.json': {
      extends: base,
      compilerOptions: { lib: ['ES2023'], types: ['audioworklet'], noEmit: true },
      include: ['./*.worklet.ts'],
    },
  };
  // The compiler's own entry, on the Node that runs this server (the dev server's PATH may have no `node`).
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const problems: string[] = [];
  const hasWorklet = (await readdir(dir)).some((f) => f.endsWith('.worklet.ts'));
  for (const [name, config] of Object.entries(configs)) {
    if (name === '.check-worklet.json' && !hasWorklet) continue;
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(config, null, 2));
    const { code, out } = await run(process.execPath, [tsc, '-p', path, '--pretty', 'false'], root, TSC_TIMEOUT_MS);
    await rm(path, { force: true });
    if (code === 0) continue;
    for (const line of out.split('\n')) {
      const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
      if (m) problems.push(`${relative(dir, join(root, m[1]!))}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`);
    }
    if (problems.length === 0) problems.push(`The type check failed: ${out.trim().slice(0, 400) || `exit code ${code}`}`);
  }
  return problems.slice(0, 25);
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

export function draftServer(root: string): Plugin {
  const plugins = join(root, 'plugins');
  const drafts = join(plugins, '_drafts');

  const handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    async '/draft'(body) {
      const folder = draftFolder(body.id);
      const files = checkFiles(body.files);
      const dir = join(drafts, folder);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      for (const f of files) await writeFile(join(dir, f.path), f.content);
      const problems = files.flatMap(scanSource);
      // Imports outside the SDK would make the type check report confusing errors first.
      if (problems.length === 0) problems.push(...(await typeCheck(root, dir)));
      return { folder, problems };
    },
    async '/install'(body) {
      const folder = draftFolder(body.id);
      const from = join(drafts, folder);
      if (!(await exists(from))) throw new DraftError('There is no draft of that plugin to install.', 404);
      const to = join(plugins, folder);
      const replaced = await exists(to);
      if (replaced) {
        const backup = join(plugins, '_backup', `${folder}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await mkdir(join(plugins, '_backup'), { recursive: true });
        await rename(to, backup);
      }
      await rename(from, to);
      return { folder, replaced };
    },
    async '/discard'(body) {
      const folder = draftFolder(body.id);
      await rm(join(drafts, folder), { recursive: true, force: true });
      return { folder };
    },
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new DraftError('The draft is too large.', 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  return {
    name: 'ag:plugin-drafts',
    configureServer(server) {
      server.middlewares.use('/api/plugins', (req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const handler = handlers[path];
        if (!handler) return next();
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
        if (req.headers['x-agstudio'] !== '1' || !sameOrigin(req))
          return send(res, 403, { error: 'Only AGstudio itself may use this endpoint.' });
        void (async () => {
          try {
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            send(res, 200, await handler(body));
          } catch (e) {
            if (e instanceof DraftError) return send(res, e.status, { error: e.message });
            if (e instanceof SyntaxError) return send(res, 400, { error: 'The request is not valid JSON.' });
            console.error('[agstudio] plugin draft request failed', e);
            send(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        })();
      });
    },
  };
}
