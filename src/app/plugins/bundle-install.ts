import { readBundle, type PluginBundle } from '@core/plugin-bundle/bundle';
import { pluginCapabilities } from '@core/plugin-bundle/capabilities';
import { replaceQuoted, withPluginId, type PluginFile } from '@core/plugin-bundle/rules';
import { PluginServerError, type FolderInfo } from './server';
import {
  PluginActionError,
  type BundleInspection,
  type Collision,
  type InstallMode,
  type InstallResult,
} from './types';
import type { UserPlugins } from './user-plugins';

/** The longest a plugin id may be, "user." included. */
const MAX_ID_LENGTH = 'user.'.length + 41;

/** A bundle that was read and checked, or why it was refused (every problem, in plain words). */
export type InspectResult = { ok: true; inspection: BundleInspection } | { ok: false; problems: string[] };

const sameFiles = (a: readonly PluginFile[], b: readonly PluginFile[]): boolean =>
  a.length === b.length && a.every((file) => b.some((other) => other.path === file.path && other.content === file.content));

/** The installed or switched-off folder whose code declares this id, from the loaded plugins and the folder listing. */
function existingFolder(up: UserPlugins, id: string): { folder: string; isDisabled: boolean } | null {
  const row = up.rows().find((candidate) => candidate.source === 'user' && candidate.id === id && candidate.folder);
  if (row) return { folder: row.folder as string, isDisabled: row.state === 'disabled' };
  const listing = up.store.getState().listing;
  const info: FolderInfo | undefined = listing?.installed.find((candidate) => candidate.id === id);
  return info ? { folder: info.folder, isDisabled: false } : null;
}

/** What installing the bundle would meet: nothing, the very same plugin, or a different one with that id. */
async function findCollision(up: UserPlugins, bundle: PluginBundle): Promise<Collision> {
  const found = existingFolder(up, bundle.manifest.id);
  if (!found) return { kind: 'none' };
  const installed = up.row(bundle.manifest.id);
  if (up.hasServer) {
    try {
      const where = found.isDisabled ? 'disabled' : 'installed';
      const { files } = await up.server.files(found.folder, where);
      if (sameFiles(files, bundle.files)) return { kind: 'identical', folder: found.folder };
    } catch {
      // Can't read it: treat it as a different plugin, which asks first.
    }
  }
  const installedVersion = installed?.version ?? null;
  const relation = installedVersion === null || bundle.manifest.version > installedVersion ? 'newer' : bundle.manifest.version === installedVersion ? 'same' : 'older';
  return { kind: 'different', folder: found.folder, installedVersion, relation, isDisabled: found.isDisabled };
}

/**
 * Reads a bundle's bytes and runs every check (`readBundle`), then looks at this AGstudio: is there a plugin with the same
 * id, how many presets are new, can it be installed here (needs the dev server). Nothing is installed.
 */
export async function inspectBundle(up: UserPlugins, bytes: Uint8Array): Promise<InspectResult> {
  const read = await readBundle(bytes);
  if (!read.ok) return { ok: false, problems: read.problems };
  const { bundle } = read;
  await up.refresh();
  const collision = await findCollision(up, bundle);
  const newPresets = bundle.presets.filter((preset) => !up.presets.find(bundle.manifest.id, preset.name)).length;
  return {
    ok: true,
    inspection: {
      bundle,
      capabilities: pluginCapabilities(bundle.manifest.kind, bundle.files),
      collision,
      newPresets,
      cannotInstall: up.hasServer
        ? null
        : "Installing a plugin needs AGstudio's dev server: run `agstudio` (that is `npm run dev`) in a terminal and use the browser tab it opens; the installed app can't do this.",
    },
  };
}

/** The first id like "user.tape-stop-2" that no plugin of yours (loaded, switched off or broken) uses. */
export function freePluginId(up: UserPlugins, wanted: string): string {
  const taken = new Set<string>();
  for (const row of up.rows()) {
    taken.add(row.id);
    if (row.folder) taken.add(`user.${row.folder}`);
  }
  for (const info of up.store.getState().listing?.installed ?? []) taken.add(`user.${info.folder}`);
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${wanted.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The code of a copy: another id (and a name that says it is a copy, when the code spells its name whole). */
export function copyOf(files: readonly PluginFile[], from: { id: string; name: string }, to: { id: string; name: string }): PluginFile[] {
  const withId = withPluginId(files, from.id, to.id);
  if (withId.changes === 0) throw new PluginActionError(`The code never says its id "${from.id}", so it cannot be copied under another one.`);
  return replaceQuoted(withId.files, from.name, to.name).files;
}

/** "Tape stop" → "Tape stop (copy)", then "(copy 2)"… against the names of the plugins you have. */
export function copyName(up: UserPlugins, name: string): string {
  const names = new Set(up.rows().map((row) => row.name.toLowerCase()));
  const base = name.replace(/ \(copy( \d+)?\)$/, '');
  let candidate = `${base} (copy)`;
  for (let n = 2; names.has(candidate.toLowerCase()); n++) candidate = `${base} (copy ${n})`;
  return candidate.slice(0, 60);
}

/** Puts the files through the dev server's draft check; throws with every problem when it finds any. */
async function draftOrThrow(up: UserPlugins, id: string, name: string, files: readonly PluginFile[]): Promise<void> {
  const { problems } = await up.server.draft(id, files);
  if (problems.length === 0) return;
  await up.server.discard(id).catch(() => {});
  throw new PluginActionError(`“${name}” did not pass the checks, so nothing was installed.`, problems);
}

/** Your presets for the new plugin: the bundle's presets whose names you do not have yet. */
function addBundlePresets(up: UserPlugins, bundle: PluginBundle, id: string): number {
  let added = 0;
  for (const preset of bundle.presets) {
    if (up.presets.find(id, preset.name)) continue;
    up.presets.save({
      pluginId: id,
      version: preset.version,
      name: preset.name,
      params: preset.params,
      ...(preset.state !== undefined ? { state: preset.state } : {}),
    });
    added++;
  }
  return added;
}

/** What the dev server answers when the folder is taken, in the musician's words. */
function installFailure(error: unknown, name: string): Error {
  if (error instanceof PluginServerError && error.status === 409)
    return new PluginActionError(`“${name}” was not installed: a plugin with that folder already exists. Choose Install as a copy, or Replace.`);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Installs a bundle that `inspectBundle` accepted:
 *  - 'new': nothing with that id exists; refuses (and changes nothing) when something does,
 *  - 'replace': the plugin with that id is replaced (its old folder goes to plugins/_backup; a switched-off one is
 *    switched on first), so projects keep their settings and `migrate` upgrades them,
 *  - 'copy': installed under a free id ("user.x-2") with the code's id rewritten, next to the original.
 * The files are checked by the dev server again (the browser is not trusted): names, sizes, imports, forbidden APIs and
 * the TypeScript compiler. Then hot reload loads the plugin and the bundle's presets are added.
 */
export async function installBundle(up: UserPlugins, bundle: PluginBundle, mode: InstallMode): Promise<InstallResult> {
  await up.requireServer('Installing a plugin');
  const { manifest } = bundle;
  const original = { id: manifest.id, name: manifest.name };
  const isCopy = mode === 'copy';
  const target = isCopy ? { id: freePluginId(up, manifest.id), name: copyName(up, manifest.name) } : original;
  const existing = existingFolder(up, manifest.id);
  if (mode === 'new' && existing) throw new PluginActionError(`There already is a plugin with the id ${manifest.id}. Choose Replace or Install as a copy.`);
  const files = isCopy ? copyOf(bundle.files, original, target) : [...bundle.files];

  await draftOrThrow(up, target.id, target.name, files);
  try {
    if (mode === 'replace' && existing?.isDisabled) await up.server.enable(existing.folder);
    // A hand-made folder with another name than the id gives would leave two folders declaring one id.
    if (mode === 'replace' && existing && existing.folder !== target.id.slice('user.'.length)) await up.server.trash(existing.folder);
    const { folder, replaced } = await up.server.install(target.id, { keepExisting: mode !== 'replace' });
    const loaded = await up.whenLoaded(target.id);
    const presetsAdded = addBundlePresets(up, bundle, target.id);
    up.meta.set(target.id, { author: manifest.author, origin: isCopy ? 'copy' : 'bundle', installedAt: Date.now() });
    await up.refresh();
    return {
      id: target.id,
      folder,
      name: target.name,
      replaced,
      loaded,
      loadError: loaded ? null : up.loadErrorFor(target.id),
      presetsAdded,
    };
  } catch (error) {
    await up.server.discard(target.id).catch(() => {});
    throw installFailure(error, target.name);
  }
}
