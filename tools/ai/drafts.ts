import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  fileListProblems,
  folderForId,
  scanSource,
  type PluginFile,
} from '../../src/core/plugin-bundle/rules.ts';
import {
  disablePlugin,
  enablePlugin,
  listPlugins,
  openPluginFolder,
  openWithSystem,
  readPluginFiles,
  restorePlugin,
  safeFolderName,
  trashPlugin,
  type FolderOpener,
} from '../plugins/library.ts';
import { DraftError, exists, pluginPaths, removeFolder, renameFolder, withForwardSlashes, type PluginPaths } from '../plugins/shared.ts';
import { typeCheck } from '../plugins/typecheck.ts';

/**
 * Plugins the musician manages from the app: the AI studio's plugin builder, "New plugin…", and sharing and managing
 * plugins (bundles, the "My plugins" window). Dev server only.
 *
 *   POST /api/plugins/draft        { id, files: [{ path, content }] } → { folder, problems: string[] }
 *   POST /api/plugins/install      { id, keepExisting? } → { folder, replaced: boolean }
 *   POST /api/plugins/discard      { id } → { folder }
 *   POST /api/plugins/new          { id, name, kind, style } → { folder, files, main }
 *   POST /api/plugins/list         → { installed, disabled, trash }  (folders, ids, files)
 *   POST /api/plugins/files        { folder, where? } → { files, skipped }
 *   POST /api/plugins/check        { folder } → { problems }    (safety scan and type check of an installed plugin)
 *   POST /api/plugins/trash        { folder } → { entry }       (plugins/_trash, recoverable)
 *   POST /api/plugins/restore      { entry } → { folder }
 *   POST /api/plugins/disable      { folder } → { folder }      (plugins/_disabled)
 *   POST /api/plugins/enable       { folder } → { folder }
 *   POST /api/plugins/open-folder  { where?, folder? } → { path }
 *
 * A draft goes to plugins/_drafts/<name>/ (discovery, the type check and lint skip folders starting
 * with "_") and is checked: file names and sizes, imports limited to the SDK, react and the draft's
 * own files, no network/storage/eval, then the TypeScript compiler. Install moves it to
 * plugins/<name>/ (an existing plugin there goes to plugins/_backup/ first, unless `keepExisting` asks to refuse
 * instead), where hot reload picks it up. The file rules are shared with the bundle reader (src/core/plugin-bundle).
 * Only same-origin requests with the `x-agstudio` header are served.
 */

const MAX_BODY_BYTES = 512 * 1024;

export { DraftError, renameFolder, typeCheck, withForwardSlashes };
export { scanSource };

/** One file of a draft: a flat file name and its text. */
export type DraftFile = PluginFile;

/** "user.tape-stop" → "tape-stop". Plugin ids the builder may write are `user.<name>`. */
export function draftFolder(id: unknown): string {
  const folder = folderForId(id);
  if (folder === null) throw new DraftError('The plugin id must look like "user.my-plugin" (lowercase letters, digits, dashes).');
  return folder;
}

/** Flat file names only: index.ts, params.ts, dsp.worklet.ts, kernel.ts, README.md… */
export function checkFiles(files: unknown): DraftFile[] {
  const [first] = fileListProblems(files);
  if (first) throw new DraftError(first);
  return (files as DraftFile[]).map((f) => ({ path: f.path, content: f.content }));
}

type RequestBody = Record<string, unknown>;

/** What the server can be given instead of the real thing, so tests run without the compiler or a file manager. */
export interface PluginApiOptions {
  typeCheck?: (root: string, dir: string) => Promise<string[]>;
  openFolder?: FolderOpener;
}

/** POST /draft: writes the files into plugins/_drafts/<name>/, then checks the imports and the types. */
async function saveDraft(paths: PluginPaths, body: RequestBody, check: NonNullable<PluginApiOptions['typeCheck']>) {
  const folder = draftFolder(body.id);
  const files = checkFiles(body.files);
  const dir = join(paths.drafts, folder);
  await removeFolder(dir);
  await mkdir(dir, { recursive: true });
  for (const f of files) await writeFile(join(dir, f.path), f.content);
  const problems = files.flatMap(scanSource);
  // Imports outside the SDK would make the type check report confusing errors first.
  if (problems.length === 0) problems.push(...(await check(paths.root, dir)));
  return { folder, problems };
}

/**
 * POST /install: moves the draft to plugins/<name>/; a plugin already there goes to plugins/_backup/ first, or with
 * `keepExisting` the install is refused (409) and nothing moves.
 */
async function installDraft(paths: PluginPaths, body: RequestBody) {
  const folder = draftFolder(body.id);
  const from = join(paths.drafts, folder);
  if (!(await exists(from))) throw new DraftError('There is no draft of that plugin to install.', 404);
  const to = join(paths.plugins, folder);
  const replaced = await exists(to);
  if (replaced && body.keepExisting === true)
    throw new DraftError(`There already is a plugin in plugins/${folder}; it was not replaced.`, 409);
  if (replaced) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(paths.backup, { recursive: true });
    await renameFolder(to, join(paths.backup, `${folder}-${stamp}`));
  }
  await renameFolder(from, to);
  return { folder, replaced };
}

/** POST /discard: deletes the draft. */
async function discardDraft(paths: PluginPaths, body: RequestBody) {
  const folder = draftFolder(body.id);
  await removeFolder(join(paths.drafts, folder));
  return { folder };
}

/** POST /new: a new plugin of your own from a template (what `npm run new:plugin` does), for Add → New plugin…. */
async function newPluginFromTemplate(paths: PluginPaths, body: RequestBody) {
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
  const template = join(paths.root, 'templates', kind === 'note-script' ? 'note-script' : `${kind}-${style}`);
  const target = join(paths.plugins, folder);
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

/** POST /check: the safety scan and the type check on a plugin where it is installed (nothing is moved or kept). */
async function checkInstalled(paths: PluginPaths, body: RequestBody, check: NonNullable<PluginApiOptions['typeCheck']>) {
  const folder = safeFolderName(body.folder);
  const dir = join(paths.plugins, folder);
  if (!(await exists(dir))) throw new DraftError('There is no such plugin folder.', 404);
  const { files } = await readPluginFiles(paths, { folder });
  const problems = files.flatMap(scanSource);
  if (problems.length === 0) problems.push(...(await check(paths.root, dir)));
  return { problems };
}

/** The endpoints, by path, working on the given plugin folders. */
export function pluginHandlers(
  paths: PluginPaths,
  options: PluginApiOptions = {},
): Record<string, (body: RequestBody) => Promise<unknown>> {
  const check = options.typeCheck ?? typeCheck;
  const openFolder = options.openFolder ?? openWithSystem;
  return {
    '/draft': (body) => saveDraft(paths, body, check),
    '/install': (body) => installDraft(paths, body),
    '/discard': (body) => discardDraft(paths, body),
    '/new': (body) => newPluginFromTemplate(paths, body),
    '/list': () => listPlugins(paths),
    '/files': (body) => readPluginFiles(paths, body),
    '/check': (body) => checkInstalled(paths, body, check),
    '/trash': (body) => trashPlugin(paths, body),
    '/restore': (body) => restorePlugin(paths, body),
    '/disable': (body) => disablePlugin(paths, body),
    '/enable': (body) => enablePlugin(paths, body),
    '/open-folder': (body) => openPluginFolder(paths, body, openFolder),
  };
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
      // Keep reading (and dropping) so the answer can still be sent: destroying the socket would show up as a reset.
      if (size > MAX_BODY_BYTES) reject(new DraftError('The request is too large.', 413));
      else chunks.push(c);
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

/** The dev-server plugin that serves `/api/plugins/*` (the plugin builder, new plugins, sharing and managing plugins). */
export function draftServer(root: string, options: PluginApiOptions & { pluginsDir?: string } = {}): Plugin {
  const handlers = pluginHandlers(pluginPaths(root, options.pluginsDir), options);

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
            const raw = await readRequestBody(req);
            const body: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
            if (typeof body !== 'object' || body === null || Array.isArray(body))
              throw new DraftError('The request must be a JSON object.');
            sendJson(res, 200, await handler(body as RequestBody));
          } catch (e) {
            if (e instanceof DraftError) return sendJson(res, e.status, { error: e.message });
            if (e instanceof SyntaxError) return sendJson(res, 400, { error: 'The request is not valid JSON.' });
            console.error('[agstudio] plugin request failed', e);
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        })();
      });
    },
  };
}
