/// <reference types="node" />
/**
 * A plugins/ folder in a temporary place, the dev server's real plugin handlers working on it, and a stand-in for hot
 * reload that keeps a registry in step with what is on disk. Tests of sharing and managing plugins use these, so they run
 * the real server code without ever touching the repository's own `plugins/` folder and without the TypeScript compiler
 * (the type check is replaced unless a test asks for the real one).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginHandlers, type PluginApiOptions } from '../../tools/ai/drafts.ts';
import { DraftError, pluginPaths, type PluginPaths } from '../../tools/plugins/shared.ts';
import { pluginServer, type PluginServer } from '@app/plugins/server';
import type { PluginRegistry } from '@app/plugins/registry';

/** A temporary plugins folder, removed by `cleanup`. */
export interface TempPlugins {
  paths: PluginPaths;
  cleanup(): Promise<void>;
}

/** Makes an empty temporary plugins folder (the project root stays the repository, which holds the templates). */
export async function tempPlugins(): Promise<TempPlugins> {
  const dir = await mkdtemp(join(tmpdir(), 'agstudio-plugins-'));
  const paths = pluginPaths(process.cwd(), join(dir, 'plugins'));
  await mkdir(paths.plugins, { recursive: true });
  return { paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes a plugin folder: `files` is path → text. */
export async function writeFolder(dir: string, folder: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(dir, folder), { recursive: true });
  for (const [path, text] of Object.entries(files)) await writeFile(join(dir, folder, path), text);
}

/** The text files of a folder, path → text. */
export async function readFolder(dir: string, folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(join(dir, folder))).sort()) out[name] = await readFile(join(dir, folder, name), 'utf8');
  return out;
}

/** The smallest working plugin source: an effect declaring `id` and `name` as quoted strings, like a real one. */
export function effectSource(id: string, name: string, version = 1): Record<string, string> {
  return {
    'index.ts': `import { defineEffect } from '@agstudio/sdk';\nexport default defineEffect({ id: '${id}', name: '${name}', version: ${version} });\n`,
  };
}

/** What hot reload would load from disk: a definition per folder, read from the folder's index file. */
async function loadFromDisk(pluginsDir: string): Promise<{ path: string; def: unknown }[]> {
  const defs: { path: string; def: unknown }[] = [];
  for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const files = (await readdir(join(pluginsDir, entry.name))).filter((name) => name.endsWith('.ts'));
    const text = (await Promise.all(files.map((name) => readFile(join(pluginsDir, entry.name, name), 'utf8')))).join('\n');
    if (!files.includes('index.ts')) continue;
    const id = /['"](user\.[a-z][a-z0-9-]*)['"]/.exec(text)?.[1];
    const name = /name:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
    const version = Number(/version:\s*(\d+)/.exec(text)?.[1] ?? 1);
    // An index without an id is a module that exports no plugin: the registry reports it as a load error.
    if (!id || !name) {
      defs.push({ path: `/plugins/${entry.name}/index.ts`, def: undefined });
      continue;
    }
    defs.push({ path: `/plugins/${entry.name}/index.ts`, def: { kind: 'effect', id, name, version, params: {}, create: () => ({}) } });
  }
  return defs;
}

/** Brings a registry in step with the folder (what Vite's hot reload does for the app). */
export async function syncRegistry(registry: PluginRegistry, pluginsDir: string): Promise<void> {
  registry.sync('user', await loadFromDisk(pluginsDir));
}

/**
 * The plugin server as the app sees it, answered by the real handlers on a temporary folder. Every call that changes the
 * folder also re-syncs `registry`, like hot reload. `options` replaces the type check or the folder opener.
 */
export function folderServer(paths: PluginPaths, registry: PluginRegistry, options: PluginApiOptions = {}): PluginServer {
  const handlers = pluginHandlers(paths, { typeCheck: async () => [], ...options });
  const fakeFetch = (async (url: string, init: { body: string }) => {
    const handler = handlers[url.replace('/api/plugins', '')];
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!handler) return respond(404, { error: 'No such endpoint.' });
    try {
      const data = await handler(JSON.parse(init.body));
      await syncRegistry(registry, paths.plugins);
      return respond(200, data);
    } catch (error) {
      if (error instanceof DraftError) return respond(error.status, { error: error.message });
      throw error;
    }
  }) as unknown as typeof fetch;
  return pluginServer(fakeFetch);
}
