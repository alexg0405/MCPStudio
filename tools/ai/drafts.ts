import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** Limits on a draft: files, bytes per file, bytes in all, bytes in one request, and how long the type check may run. */
const MAX_FILES = 8;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 512 * 1024;
const TSC_TIMEOUT_MS = 90_000;

/** A problem with a draft request, with the HTTP status to answer with. */
export class DraftError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** One file of a draft: a flat file name and its text. */
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
    if (typeof path !== 'string' || typeof content !== 'string')
      throw new DraftError('Every file needs a path and text.');
    if (!/^[a-z0-9][a-z0-9_-]{0,48}(\.(worklet|kernel))?\.(ts|tsx|md|dsp)$/i.test(path) || /^tsconfig/i.test(path))
      throw new DraftError(`"${path}" is not an allowed file name (flat names ending in .ts, .tsx, .dsp or .md).`);
    if (seen.has(path.toLowerCase())) throw new DraftError(`"${path}" appears twice.`);
    seen.add(path.toLowerCase());
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new DraftError(`"${path}" is too large (${Math.round(bytes / 1024)} KB).`);
    total += bytes;
    out.push({ path, content });
  }
  if (total > MAX_TOTAL_BYTES) throw new DraftError('The draft is too large.');
  if (!seen.has('index.ts') && !seen.has('index.tsx'))
    throw new DraftError('A plugin needs an index.ts (or index.tsx).');
  return out;
}

const MAIN_IMPORTS = /^(@agstudio\/sdk(\/(params|ui|notes|worklet|dsp|faust))?|react|react\/jsx-runtime)$/;
const WORKLET_IMPORTS = /^@agstudio\/sdk\/(worklet|params)$/;
const LOCAL_IMPORT = /^\.\/[A-Za-z0-9_.-]+?(\.(ts|tsx|dsp))?(\?worker&url)?$/;

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
  // Faust code can only compute audio; Markdown is text.
  if (file.path.endsWith('.md') || file.path.endsWith('.dsp')) return [];
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

/** Runs a program and collects its output; a timeout kills it, a failure to start gives code -1. */
function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
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
  // `import dsp from './x.dsp'` in Faust plugins.
  const dspModules = relative(dir, join(root, 'src', 'sdk', 'faust', 'modules.d.ts'));
  const configs = {
    '.check-main.json': {
      extends: base,
      compilerOptions: {
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        types: ['vite/client'],
        jsx: 'react-jsx',
        noEmit: true,
      },
      include: ['./*.ts', './*.tsx', dspModules],
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
    if (problems.length === 0)
      problems.push(`The type check failed: ${out.trim().slice(0, 400) || `exit code ${code}`}`);
  }
  return problems.slice(0, 25);
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The folders a draft moves between: `plugins/` (installed), `plugins/_drafts/` and `plugins/_backup/`. */
function pluginFolders(root: string) {
  const plugins = join(root, 'plugins');
  return { plugins, drafts: join(plugins, '_drafts'), backup: join(plugins, '_backup') };
}

type RequestBody = Record<string, unknown>;

/** POST /draft: writes the files into plugins/_drafts/<name>/, then checks the imports and the types. */
async function saveDraft(root: string, body: RequestBody) {
  const folder = draftFolder(body.id);
  const files = checkFiles(body.files);
  const dir = join(pluginFolders(root).drafts, folder);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(join(dir, f.path), f.content);
  const problems = files.flatMap(scanSource);
  // Imports outside the SDK would make the type check report confusing errors first.
  if (problems.length === 0) problems.push(...(await typeCheck(root, dir)));
  return { folder, problems };
}

/** POST /install: moves the draft to plugins/<name>/; a plugin already there goes to plugins/_backup/ first. */
async function installDraft(root: string, body: RequestBody) {
  const folder = draftFolder(body.id);
  const { plugins, drafts, backup } = pluginFolders(root);
  const from = join(drafts, folder);
  if (!(await exists(from))) throw new DraftError('There is no draft of that plugin to install.', 404);
  const to = join(plugins, folder);
  const replaced = await exists(to);
  if (replaced) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(backup, { recursive: true });
    await rename(to, join(backup, `${folder}-${stamp}`));
  }
  await rename(from, to);
  return { folder, replaced };
}

/** POST /discard: deletes the draft. */
async function discardDraft(root: string, body: RequestBody) {
  const folder = draftFolder(body.id);
  await rm(join(pluginFolders(root).drafts, folder), { recursive: true, force: true });
  return { folder };
}

/** POST /new: a new plugin of your own from a template (what `npm run new:plugin` does), for Add → New plugin…. */
async function newPluginFromTemplate(root: string, body: RequestBody) {
  const folder = draftFolder(body.id);
  const kind = body.kind === 'effect' || body.kind === 'note-script' ? body.kind : 'instrument';
  const style = body.style === 'worklet' || body.style === 'faust' ? body.style : 'graph';
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name
          .trim()
          .slice(0, 60)
          .replace(/['"`$\\]/g, '')
      : folder;
  const template = join(root, 'templates', kind === 'note-script' ? 'note-script' : `${kind}-${style}`);
  const target = join(pluginFolders(root).plugins, folder);
  if (await exists(target)) throw new DraftError(`There already is a plugin folder plugins/${folder}.`, 409);
  await cp(template, target, { recursive: true });
  const files = await fillPlaceholders(target, String(body.id), name);
  // The file to start editing: the DSP for worklet and Faust plugins, else the definition.
  const main =
    kind === 'note-script' || style === 'graph'
      ? 'index.ts'
      : (files.find((f) => f.endsWith('.worklet.ts') || f.endsWith('.dsp')) ?? 'index.ts');
  return { folder, files, main: `plugins/${folder}/${main}` };
}

/** Writes the plugin's id and name into the copied template's `__PLUGIN_ID__` and `__PLUGIN_NAME__`. Returns the file paths. */
async function fillPlaceholders(target: string, pluginId: string, pluginName: string): Promise<string[]> {
  const files: string[] = [];
  const fill = async (dir: string, relativeDir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await fill(path, `${relativeDir}${entry.name}/`);
        continue;
      }
      const text = await readFile(path, 'utf8');
      await writeFile(path, text.replaceAll('__PLUGIN_ID__', pluginId).replaceAll('__PLUGIN_NAME__', pluginName));
      files.push(`${relativeDir}${entry.name}`);
    }
  };
  await fill(target, '');
  return files;
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
};

const readRequestBody = (req: IncomingMessage) =>
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

/** True when the request has no Origin header or comes from the page this server serves. */
const isSameOrigin = (req: IncomingMessage) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};

/** The dev-server plugin that serves `/api/plugins/*` for the AI studio's plugin builder. */
export function draftServer(root: string): Plugin {
  const handlers: Record<string, (body: RequestBody) => Promise<unknown>> = {
    '/draft': (body) => saveDraft(root, body),
    '/install': (body) => installDraft(root, body),
    '/discard': (body) => discardDraft(root, body),
    '/new': (body) => newPluginFromTemplate(root, body),
  };

  return {
    name: 'ag:plugin-drafts',
    configureServer(server) {
      server.middlewares.use('/api/plugins', (req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const handler = handlers[path];
        if (!handler) return next();
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
        if (req.headers['x-agstudio'] !== '1' || !isSameOrigin(req)) {
          return sendJson(res, 403, { error: 'Only AGstudio itself may use this endpoint.' });
        }
        void (async () => {
          try {
            const body = JSON.parse(await readRequestBody(req)) as RequestBody;
            sendJson(res, 200, await handler(body));
          } catch (e) {
            if (e instanceof DraftError) return sendJson(res, e.status, { error: e.message });
            if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'The request is not valid JSON.' });
            console.error('[agstudio] plugin draft request failed', e);
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        })();
      });
    },
  };
}
