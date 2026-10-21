/**
 * A plugin server that keeps the plugins/ folder in memory, for tests that run in the browser (no files there). It answers
 * the calls `UserPlugins` makes the way the dev server does (draft → install, trash, disable…) and, like hot reload, keeps a
 * registry in step with what is "installed". The real handlers are tested against a real folder in plugin-server.test.ts.
 */
import { pluginFileProblems, type PluginFile } from '@core/plugin-bundle/rules';
import type { PluginRegistry } from '@app/plugins/registry';
import { PluginServerError, type FolderInfo, type PluginServer } from '@app/plugins/server';

type Folder = Record<string, string>;

const ID = /['"](user\.[a-z][a-z0-9-]*)['"]/;

const infoOf = (folder: string, files: Folder): FolderInfo => ({
  folder,
  id: Object.values(files).map((text) => ID.exec(text)?.[1]).find(Boolean) ?? null,
  files: Object.entries(files).map(([path, text]) => ({ path, bytes: text.length })),
  modified: 1_700_000_000_000,
});

/** A server over folders held in memory. `registry` follows the installed ones like hot reload does. */
export function memoryPluginServer(registry: PluginRegistry): PluginServer & { installed: Map<string, Folder>; trashed: Map<string, Folder> } {
  const installed = new Map<string, Folder>();
  const disabled = new Map<string, Folder>();
  const trashed = new Map<string, Folder>();
  const drafts = new Map<string, Folder>();
  const sync = () => {
    registry.sync(
      'user',
      [...installed].map(([folder, files]) => {
        const text = Object.values(files).join('\n');
        const id = ID.exec(text)?.[1];
        const name = /name:\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? folder;
        const version = Number(/version:\s*(\d+)/.exec(text)?.[1] ?? 1);
        const kind = /defineInstrument|defineWorkletInstrument|defineFaustInstrument/.test(text) ? 'instrument' : 'effect';
        return { path: `/plugins/${folder}/index.ts`, def: id ? { kind, id, name, version, params: {}, create: () => ({}) } : undefined };
      }),
    );
  };
  const folderOf = (id: string) => id.slice('user.'.length);
  const take = (map: Map<string, Folder>, key: string, what: string): Folder => {
    const found = map.get(key);
    if (!found) throw new PluginServerError(`There is no such ${what}.`, 'refused', 404);
    return found;
  };
  const server: PluginServer = {
    list: async () => ({
      installed: [...installed].map(([folder, files]) => infoOf(folder, files)),
      disabled: [...disabled].map(([folder, files]) => infoOf(folder, files)),
      trash: [...trashed].map(([folder, files]) => infoOf(folder, files)),
    }),
    files: async (folder, where = 'installed') => {
      const source = where === 'installed' ? installed : where === 'disabled' ? disabled : trashed;
      const files = take(source, folder, 'plugin folder');
      return { files: Object.entries(files).map(([path, content]): PluginFile => ({ path, content })), skipped: [] };
    },
    draft: async (id, files) => {
      const problems = pluginFileProblems(files);
      drafts.set(folderOf(id), Object.fromEntries(files.map((file) => [file.path, file.content])));
      return { folder: folderOf(id), problems };
    },
    install: async (id, options = {}) => {
      const folder = folderOf(id);
      const draft = take(drafts, folder, 'draft');
      const replaced = installed.has(folder);
      if (replaced && options.keepExisting) throw new PluginServerError(`There already is a plugin in plugins/${folder}; it was not replaced.`, 'refused', 409);
      installed.set(folder, draft);
      drafts.delete(folder);
      sync();
      return { folder, replaced };
    },
    discard: async (id) => void drafts.delete(folderOf(id)),
    check: async (folder) => {
      take(installed, folder, 'plugin folder');
      return { problems: [] };
    },
    trash: async (folder, where = 'installed') => {
      const source = where === 'installed' ? installed : disabled;
      const files = take(source, folder, 'plugin folder');
      source.delete(folder);
      const entry = `${folder}-20260101T120000Z`;
      trashed.set(entry, files);
      sync();
      return { entry };
    },
    restore: async (entry) => {
      const files = take(trashed, entry, 'plugin in the trash');
      const folder = entry.replace(/-\d{8}T\d{6}Z$/, '');
      if (installed.has(folder)) throw new PluginServerError(`There already is a plugin in plugins/${folder}.`, 'refused', 409);
      trashed.delete(entry);
      installed.set(folder, files);
      sync();
      return { folder };
    },
    disable: async (folder) => {
      disabled.set(folder, take(installed, folder, 'plugin folder'));
      installed.delete(folder);
      sync();
      return { folder };
    },
    enable: async (folder) => {
      installed.set(folder, take(disabled, folder, 'switched-off plugin'));
      disabled.delete(folder);
      sync();
      return { folder };
    },
    openFolder: async () => ({ path: '/plugins' }),
  };
  return Object.assign(server, { installed, trashed });
}
