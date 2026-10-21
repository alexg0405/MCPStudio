import { createStore, type StoreApi } from 'zustand/vanilla';
import type { History } from '@core/history/history';
import type { BundleKind } from '@core/plugin-bundle/manifest';
import { pluginUsage, type PluginUse } from '@core/query/plugin-usage';
import type { DocStore } from '../stores/doc';
import type { SessionStore } from '../stores/session';
import type { PresetLibrary } from '../presets';
import { PluginMeta } from './meta';
import type { PluginRegistry } from './registry';
import { PluginServerError, pluginServer, type FolderInfo, type PluginListing, type PluginServer } from './server';
import { PluginActionError, type PluginRow, type TrashRow } from './types';

/** What the "My plugins" manager and everything that shares or installs plugins is built on. */
export interface UserPluginsDeps {
  plugins: PluginRegistry;
  doc: DocStore;
  history: History;
  presets: PresetLibrary;
  session: SessionStore;
  /** The dev server's plugin endpoints (default: the page's fetch). Tests pass handlers or fakes. */
  server?: PluginServer;
  meta?: PluginMeta;
}

/** What the manager keeps besides the registry: what is on disk, whether a server answered, and the last checks. */
export interface UserPluginsState {
  /** The plugin folders on disk, null until the server has answered once. */
  listing: PluginListing | null;
  /** unknown: not asked yet; ok: the dev server answered; missing: no dev server (the installed app, or `agstudio` is not running). */
  server: 'unknown' | 'ok' | 'missing';
  /** The last check's problems by plugin id. */
  checks: Record<string, string[]>;
}

const NO_USE: PluginUse = { channels: [], inserts: [] };
const FOLDER_OF_PATH = /^\/?plugins\/([^/]+)\//;

/** The `plugins/<folder>` a discovered module path belongs to ("/plugins/x/index.ts" → "x"). */
export function folderOfModulePath(path: string): string | null {
  return FOLDER_OF_PATH.exec(path)?.[1] ?? null;
}

/**
 * Your own plugins as a set of things you manage: the loaded ones (from the registry), the switched-off ones and the
 * trash (from the dev server's folder listing), and the actions on them. The actions that need to ask the musician
 * something (collisions, "are you sure") are driven by the UI (`ui/features/plugin-manager`); everything here is
 * decided by arguments, so commands, the AI and tests can use it too.
 *
 * Bundles, duplicates and renames live in `bundle-install.ts`, `bundle-export.ts` and `plugin-edit.ts` and are
 * methods here only as thin doors, to keep this file about the list.
 */
export class UserPlugins {
  readonly store: StoreApi<UserPluginsState> = createStore<UserPluginsState>()(() => ({
    listing: null,
    server: 'unknown',
    checks: {},
  }));
  readonly plugins: PluginRegistry;
  readonly doc: DocStore;
  readonly history: History;
  readonly presets: PresetLibrary;
  readonly session: SessionStore;
  readonly server: PluginServer;
  readonly meta: PluginMeta;
  private refreshing: Promise<void> | null = null;

  constructor(deps: UserPluginsDeps) {
    this.plugins = deps.plugins;
    this.doc = deps.doc;
    this.history = deps.history;
    this.presets = deps.presets;
    this.session = deps.session;
    this.server = deps.server ?? pluginServer();
    this.meta = deps.meta ?? new PluginMeta();
  }

  /** Reads the plugin folders from the dev server (one read at a time); notes when there is no server. */
  refresh(): Promise<void> {
    return (this.refreshing ??= this.readListing().finally(() => {
      this.refreshing = null;
    }));
  }

  private async readListing(): Promise<void> {
    try {
      const listing = await this.server.list();
      this.store.setState({ listing, server: 'ok' });
    } catch (error) {
      if (error instanceof PluginServerError && error.kind === 'no-server') this.store.setState({ listing: null, server: 'missing' });
      else throw error;
    }
  }

  /** True once a dev server has answered (managing, sharing and installing work). */
  get hasServer(): boolean {
    return this.store.getState().server === 'ok';
  }

  /** Refreshes the listing and throws the plain "needs the dev server" sentence when there is none. */
  async requireServer(what: string): Promise<PluginListing> {
    await this.refresh();
    const { listing, server } = this.store.getState();
    if (server !== 'ok' || !listing) throw new PluginActionError(`${what} needs AGstudio's dev server: run \`agstudio\` (that is \`npm run dev\`) in a terminal and use the browser tab it opens; the installed app can't do this.`);
    return listing;
  }

  /** Every plugin of yours (loaded, broken or switched off) then the built-ins, by name. */
  rows(): PluginRow[] {
    const { listing, checks } = this.store.getState();
    const usage = pluginUsage(this.doc.getState().project);
    const folderInfo = (folder: string | null, place: 'installed' | 'disabled'): FolderInfo | undefined =>
      folder ? listing?.[place].find((info) => info.folder === folder) : undefined;
    const rows: PluginRow[] = [];
    const seenFolders = new Set<string>();

    const addLoaded = (id: string, def: { name: string; version: number; description?: string; kind: BundleKind }, source: 'builtin' | 'user', path: string) => {
      const folder = source === 'user' ? folderOfModulePath(path) : null;
      if (folder) seenFolders.add(folder);
      rows.push({
        id,
        name: def.name,
        kind: def.kind,
        version: def.version,
        author: this.meta.get(id).author ?? '',
        description: def.description ?? '',
        source,
        state: 'loaded',
        folder,
        error: null,
        problems: checks[id] ?? [],
        isChecked: id in checks,
        fileCount: folderInfo(folder, 'installed')?.files.length ?? 0,
        usedIn: usage.get(id) ?? NO_USE,
      });
    };
    for (const entry of this.plugins.list()) addLoaded(entry.def.id, entry.def, entry.source, entry.path);
    for (const entry of this.plugins.scripts()) addLoaded(entry.def.id, entry.def, entry.source, entry.path);

    for (const failure of this.plugins.loadErrors()) {
      if (failure.source !== 'user') continue;
      const folder = folderOfModulePath(failure.path);
      if (!folder || seenFolders.has(folder)) continue;
      seenFolders.add(folder);
      const info = folderInfo(folder, 'installed');
      const id = info?.id ?? `user.${folder}`;
      rows.push({
        id,
        name: folder,
        kind: null,
        version: null,
        author: this.meta.get(id).author ?? '',
        description: '',
        source: 'user',
        state: 'error',
        folder,
        error: failure.error,
        problems: checks[id] ?? [],
        isChecked: id in checks,
        fileCount: info?.files.length ?? 0,
        usedIn: usage.get(id) ?? NO_USE,
      });
    }
    for (const info of listing?.disabled ?? []) {
      const id = info.id ?? `user.${info.folder}`;
      rows.push({
        id,
        name: info.folder,
        kind: null,
        version: null,
        author: this.meta.get(id).author ?? '',
        description: 'Switched off: AGstudio does not load it.',
        source: 'user',
        state: 'disabled',
        folder: info.folder,
        error: null,
        problems: [],
        isChecked: false,
        fileCount: info.files.length,
        usedIn: usage.get(id) ?? NO_USE,
      });
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return rows.sort((a, b) => Number(a.source === 'builtin') - Number(b.source === 'builtin') || collator.compare(a.name, b.name));
  }

  /** One row by plugin id. */
  row(id: string): PluginRow | undefined {
    return this.rows().find((row) => row.id === id);
  }

  /** The deleted plugins that can still be brought back, newest first. */
  trashRows(): TrashRow[] {
    return (this.store.getState().listing?.trash ?? [])
      .map((info) => ({
        entry: info.folder,
        folder: info.folder.replace(/-\d{8}T\d{6}Z$/, ''),
        id: info.id,
        fileCount: info.files.length,
        modified: info.modified,
      }))
      .sort((a, b) => b.entry.localeCompare(a.entry));
  }

  /** Your plugin's row, or a plain refusal (built-ins have no code of yours to manage). */
  userRow(id: string): PluginRow {
    const row = this.row(id);
    if (!row) throw new PluginActionError(`There is no plugin “${id}”. Look in the browser under Plugins, or in My plugins.`);
    if (row.source !== 'user' || !row.folder) throw new PluginActionError(`“${row.name}” is built in: it cannot be changed, shared or removed here. Duplicate-and-edit is for your own plugins.`);
    return row;
  }

  /** Switches a plugin off: its folder moves to plugins/_disabled, and it stops loading (projects using it show it missing until it is back). */
  async disable(id: string): Promise<void> {
    const row = this.userRow(id);
    await this.requireServer('Switching a plugin off');
    await this.server.disable(row.folder as string);
    await this.refresh();
  }

  /** Switches a plugin back on (the folder moves back to plugins/). */
  async enable(id: string): Promise<void> {
    const row = this.userRow(id);
    if (row.state !== 'disabled') return;
    await this.requireServer('Switching a plugin on');
    await this.server.enable(row.folder as string);
    await this.refresh();
  }

  /** Deletes a plugin to plugins/_trash (recoverable with `restore`). Returns the trash entry. */
  async trash(id: string): Promise<string> {
    const row = this.userRow(id);
    await this.requireServer('Deleting a plugin');
    const { entry } = await this.server.trash(row.folder as string, row.state === 'disabled' ? 'disabled' : 'installed');
    await this.refresh();
    return entry;
  }

  /** Brings a deleted plugin back to plugins/ (refused while a plugin has its folder). */
  async restore(entry: string): Promise<string> {
    await this.requireServer('Restoring a plugin');
    const { folder } = await this.server.restore(entry);
    await this.refresh();
    return folder;
  }

  /** Shows plugins/ (or one plugin's folder) in the computer's file manager. */
  async openFolder(id?: string): Promise<void> {
    await this.requireServer('Opening the plugins folder');
    await this.server.openFolder(id ? (this.userRow(id).folder as string) : undefined);
  }

  /** Runs the safety scan and the type check on an installed plugin and keeps what they found for the list. */
  async check(id: string): Promise<string[]> {
    const row = this.userRow(id);
    await this.requireServer('Checking a plugin');
    const { problems } = await this.server.check(row.folder as string);
    this.store.setState((state) => ({ checks: { ...state.checks, [id]: problems } }));
    return problems;
  }

  /** Waits (up to `ms`) for hot reload to bring a plugin into the registry; false when it does not come. */
  whenLoaded(id: string, ms = 15_000): Promise<boolean> {
    const isThere = () => !!this.plugins.get(id) || !!this.plugins.script(id);
    if (isThere()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      const off = this.plugins.subscribe(() => {
        if (!isThere()) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  /** Waits for a plugin to leave the registry (after its folder was moved away). */
  whenGone(id: string, ms = 15_000): Promise<boolean> {
    const isThere = () => !!this.plugins.get(id) || !!this.plugins.script(id);
    if (!isThere()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      const off = this.plugins.subscribe(() => {
        if (isThere()) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  /** The words of the last load failure for a plugin id, if the loader reported one. */
  loadErrorFor(id: string): string | null {
    const folder = id.startsWith('user.') ? id.slice('user.'.length) : null;
    const failure = this.plugins.loadErrors().find((e) => e.source === 'user' && folderOfModulePath(e.path) === folder);
    return failure?.error ?? null;
  }

  /** Tells the musician something (a toast). */
  say(text: string, kind?: 'error'): void {
    this.session.getState().toast(text, kind);
  }
}
