/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { draftServer, pluginHandlers } from '../../tools/ai/drafts.ts';
import { folderOfTrashEntry, safeFolderName } from '../../tools/plugins/library.ts';
import { effectSource, readFolder, tempPlugins, writeFolder, type TempPlugins } from '../helpers/plugin-folder';

/** The dev server's plugin endpoints on a temporary plugins folder (never the repository's own plugins/). */
describe('plugin endpoints', () => {
  let disk: TempPlugins;
  let typeChecks: string[];
  const handlers = () =>
    pluginHandlers(disk.paths, {
      typeCheck: async (_root, dir) => {
        typeChecks.push(dir);
        return [];
      },
      openFolder: async () => {},
    });

  beforeEach(async () => {
    disk = await tempPlugins();
    typeChecks = [];
  });
  afterEach(() => disk.cleanup());

  it('writes a draft, checks it, and installs it only on request', async () => {
    const h = handlers();
    const files = Object.entries(effectSource('user.tape-stop', 'Tape stop')).map(([path, content]) => ({ path, content }));
    expect(await h['/draft']!({ id: 'user.tape-stop', files })).toEqual({ folder: 'tape-stop', problems: [] });
    expect(typeChecks).toEqual([join(disk.paths.drafts, 'tape-stop')]);
    expect(await readdir(disk.paths.plugins)).toEqual(['_drafts']);
    expect(await h['/install']!({ id: 'user.tape-stop' })).toEqual({ folder: 'tape-stop', replaced: false });
    expect(await readFolder(disk.paths.plugins, 'tape-stop')).toEqual(effectSource('user.tape-stop', 'Tape stop'));
  });

  it('refuses forbidden code in a draft before the compiler runs', async () => {
    const files = [{ path: 'index.ts', content: `fetch('/x');` }];
    const answer = (await handlers()['/draft']!({ id: 'user.bad', files })) as { problems: string[] };
    expect(answer.problems[0]).toMatch(/network access/);
    expect(typeChecks).toEqual([]);
  });

  it('refuses a bad id, nested folders, too many files and too large files', async () => {
    const h = handlers();
    const one = [{ path: 'index.ts', content: '' }];
    await expect(h['/draft']!({ id: 'tape', files: one })).rejects.toThrow(/must look like/);
    await expect(h['/draft']!({ id: 'user.x1', files: [...one, { path: 'sub/a.ts', content: '' }] })).rejects.toThrow(/allowed file name/);
    await expect(h['/draft']!({ id: 'user.x1', files: [...one, ...Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, content: '' }))] })).rejects.toThrow(/at most 8/);
    await expect(h['/draft']!({ id: 'user.x1', files: [{ path: 'index.ts', content: 'x'.repeat(70_000) }] })).rejects.toThrow(/too large/);
  });

  it('install keeps a plugin that is there when asked to, and backs it up otherwise', async () => {
    const h = handlers();
    const draft = async (name: string) =>
      h['/draft']!({ id: 'user.tape-stop', files: Object.entries(effectSource('user.tape-stop', name)).map(([path, content]) => ({ path, content })) });
    await draft('First');
    await h['/install']!({ id: 'user.tape-stop' });
    await draft('Second');
    await expect(h['/install']!({ id: 'user.tape-stop', keepExisting: true })).rejects.toMatchObject({ status: 409 });
    expect((await readFolder(disk.paths.plugins, 'tape-stop'))['index.ts']).toContain('First');
    expect(await h['/install']!({ id: 'user.tape-stop' })).toEqual({ folder: 'tape-stop', replaced: true });
    expect((await readFolder(disk.paths.plugins, 'tape-stop'))['index.ts']).toContain('Second');
    expect(await readdir(disk.paths.backup)).toHaveLength(1);
  });

  it('lists folders by place, reads their files and tells what it left out', async () => {
    const h = handlers();
    await writeFolder(disk.paths.plugins, 'tape-stop', { ...effectSource('user.tape-stop', 'Tape stop'), 'notes.txt': 'not source' });
    await mkdir(join(disk.paths.plugins, 'tape-stop', 'sub'));
    await h['/disable']!({ folder: 'tape-stop' });
    const listing = (await h['/list']!({})) as { installed: unknown[]; disabled: { folder: string; id: string; files: { path: string }[] }[]; trash: unknown[] };
    expect(listing.installed).toEqual([]);
    expect(listing.disabled).toMatchObject([{ folder: 'tape-stop', id: 'user.tape-stop' }]);
    const read = (await h['/files']!({ folder: 'tape-stop', where: 'disabled' })) as { files: { path: string }[]; skipped: string[] };
    expect(read.files.map((f) => f.path)).toEqual(['index.ts']);
    expect(read.skipped.sort()).toEqual(['notes.txt', 'sub/']);
  });

  it('trashes and restores, refusing to overwrite', async () => {
    const h = handlers();
    await writeFolder(disk.paths.plugins, 'a-plugin', effectSource('user.a-plugin', 'A'));
    const { entry } = (await h['/trash']!({ folder: 'a-plugin' })) as { entry: string };
    expect(folderOfTrashEntry(entry)).toBe('a-plugin');
    await writeFolder(disk.paths.plugins, 'a-plugin', effectSource('user.a-plugin', 'B'));
    await expect(h['/restore']!({ entry })).rejects.toMatchObject({ status: 409 });
    await expect(h['/trash']!({ folder: 'nothing-here' })).rejects.toMatchObject({ status: 404 });
    expect(await readdir(disk.paths.trash)).toEqual([entry]);
  });

  it('never leaves the plugin folders: names with dots, slashes or a leading underscore are refused', async () => {
    const h = handlers();
    for (const bad of ['../x', 'a/b', '_drafts', '.hidden', '', 'a..b', 42, undefined]) {
      expect(() => safeFolderName(bad)).toThrow(/not a valid/);
      await expect(h['/trash']!({ folder: bad })).rejects.toThrow(/not a valid/);
      await expect(h['/files']!({ folder: bad })).rejects.toThrow(/not a valid/);
    }
    await expect(h['/restore']!({ entry: '../../etc' })).rejects.toThrow(/not a valid/);
  });

  it('opens the folder it is told to, only inside plugins/', async () => {
    const opened: string[] = [];
    const h = pluginHandlers(disk.paths, { openFolder: async (path) => void opened.push(path) });
    await writeFolder(disk.paths.plugins, 'tape-stop', effectSource('user.tape-stop', 'T'));
    await h['/open-folder']!({});
    await h['/open-folder']!({ folder: 'tape-stop' });
    expect(opened).toEqual([disk.paths.plugins, join(disk.paths.plugins, 'tape-stop')]);
    await expect(h['/open-folder']!({ folder: '../..' })).rejects.toThrow(/not a valid/);
  });

  it('checks an installed plugin where it is, scan first', async () => {
    const h = handlers();
    await writeFolder(disk.paths.plugins, 'ok', effectSource('user.ok', 'Ok'));
    expect(await h['/check']!({ folder: 'ok' })).toEqual({ problems: [] });
    expect(typeChecks).toEqual([join(disk.paths.plugins, 'ok')]);
    await writeFolder(disk.paths.plugins, 'bad', { 'index.ts': `eval('1');` });
    const bad = (await h['/check']!({ folder: 'bad' })) as { problems: string[] };
    expect(bad.problems[0]).toMatch(/eval/);
  });
});

describe('plugin endpoints over HTTP', () => {
  let disk: TempPlugins;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    disk = await tempPlugins();
    const plugin = draftServer(disk.paths.root, { pluginsDir: disk.paths.plugins, typeCheck: async () => [] });
    const stack: ((req: never, res: never, next: () => void) => void)[] = [];
    (plugin.configureServer as (s: unknown) => void)({
      middlewares: { use: (_path: string, fn: (typeof stack)[number]) => stack.push(fn) },
    });
    server = createServer((req, res) => {
      req.url = req.url!.replace('/api/plugins', '');
      stack[0]!(req as never, res as never, () => {
        res.statusCode = 404;
        res.end('next');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.close();
    await disk.cleanup();
  });

  const post = (path: string, headers: Record<string, string>, body = '{}', method = 'POST') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/plugins${path}`, method, headers }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });

  it('serves only POSTs from AGstudio itself: the header, and the same origin', async () => {
    expect((await post('/list', { 'x-agstudio': '1' })).status).toBe(200);
    expect((await post('/list', {})).status).toBe(403);
    expect((await post('/list', { 'x-agstudio': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/list', { 'x-agstudio': '1', origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await post('/list', { 'x-agstudio': '1' }, '', 'GET')).status).toBe(405);
    expect((await post('/unknown', { 'x-agstudio': '1' })).status).toBe(404);
  });

  it('answers a request that is not a JSON object with a plain error, not a crash', async () => {
    const asJson = { 'x-agstudio': '1', 'content-type': 'application/json' };
    expect((await post('/list', asJson, 'null')).status).toBe(400);
    expect((await post('/list', asJson, '[1]')).status).toBe(400);
    expect((await post('/list', asJson, '{oops')).status).toBe(400);
    const big = await post('/draft', asJson, JSON.stringify({ id: 'user.x1', files: [{ path: 'index.ts', content: 'x'.repeat(600_000) }] }));
    expect(big.status).toBe(413);
  });

  it('never touches the repository’s own plugins folder', async () => {
    await post('/draft', { 'x-agstudio': '1' }, JSON.stringify({ id: 'user.http-test', files: [{ path: 'index.ts', content: 'export {};' }] }));
    expect(await readdir(join(disk.paths.drafts))).toEqual(['http-test']);
    expect(await readFile(join(disk.paths.drafts, 'http-test', 'index.ts'), 'utf8')).toBe('export {};');
    expect(await readdir(join(process.cwd(), 'plugins')).then((names) => names.includes('http-test'))).toBe(false);
  });
});
