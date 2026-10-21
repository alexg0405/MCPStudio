import { renamePluginId } from '@core/ops/plugin-rename';
import { USER_PLUGIN_ID, withPluginId } from '@core/plugin-bundle/rules';
import { copyName, copyOf, freePluginId } from './bundle-install';
import { pluginIdFor } from './new-plugin';
import { PluginActionError } from './types';
import type { UserPlugins } from './user-plugins';

/** What a duplicate made. */
export interface DuplicateResult {
  id: string;
  name: string;
  folder: string;
  loaded: boolean;
}

/** What a rename changed: where the project and your saved things followed the new id. */
export interface RenameResult {
  from: string;
  to: string;
  /** Channels and effect slots (and mixer snapshots) in the open project that now use the new id. */
  projectPlaces: number;
  /** Your presets and chain steps that followed. */
  savedThings: number;
}

/**
 * Makes a new plugin of yours from an existing one: the same code under a free id (from `name`, or "<name> (copy)") that
 * loads next to the original. The original is not touched; presets are not copied (they belong to the original's id).
 */
export async function duplicatePlugin(up: UserPlugins, id: string, name?: string): Promise<DuplicateResult> {
  const row = up.userRow(id);
  if (row.state !== 'loaded') throw new PluginActionError(`“${row.name}” is not loaded, so it cannot be copied.`);
  await up.requireServer('Duplicating a plugin');
  const { files } = await up.server.files(row.folder as string);
  const newName = (name ?? '').trim() ? (name as string).trim().slice(0, 60) : copyName(up, row.name);
  const newId = freePluginId(up, pluginIdFor(newName));
  const copy = copyOf(files, { id, name: row.name }, { id: newId, name: newName });
  const { problems } = await up.server.draft(newId, copy);
  if (problems.length > 0) {
    await up.server.discard(newId).catch(() => {});
    throw new PluginActionError(`The copy did not pass the checks, so nothing was made.`, problems);
  }
  const { folder } = await up.server.install(newId, { keepExisting: true });
  const loaded = await up.whenLoaded(newId);
  up.meta.set(newId, { author: up.meta.get(id).author ?? '', origin: 'copy', installedAt: Date.now() });
  await up.refresh();
  return { id: newId, name: newName, folder, loaded };
}

/** Whether `to` can be the new id of a plugin: well-formed and free. Returns the reason it cannot, or null. */
export function renameProblem(up: UserPlugins, from: string, to: string): string | null {
  if (!USER_PLUGIN_ID.test(to)) return 'The id must look like "user.my-plugin": lowercase letters, digits and dashes, starting with a letter.';
  if (to === from) return 'That is already its id.';
  if (freePluginId(up, to) !== to) return `Something already uses the id ${to} (or its folder).`;
  return null;
}

/**
 * Gives a plugin of yours a new id, safely. The code is copied to the new folder with its id rewritten, and loads next to
 * the old one; then the open project (channels, effects, mixer snapshots) and your presets and chains are pointed at the
 * new id, with the project change as one undo step; last, the old folder goes to plugins/_trash (so a mistake can be
 * undone from there). Nothing the project plays is ever without its plugin in between.
 */
export async function renamePlugin(up: UserPlugins, from: string, to: string): Promise<RenameResult> {
  const row = up.userRow(from);
  if (row.state !== 'loaded') throw new PluginActionError(`“${row.name}” is not loaded, so it cannot be renamed.`);
  const problem = renameProblem(up, from, to);
  if (problem) throw new PluginActionError(problem);
  await up.requireServer('Renaming a plugin');
  const { files } = await up.server.files(row.folder as string);
  const renamed = withPluginId(files, from, to);
  if (renamed.changes === 0) throw new PluginActionError(`The code never says its id "${from}", so it cannot be renamed safely.`);
  const { problems } = await up.server.draft(to, renamed.files);
  if (problems.length > 0) {
    await up.server.discard(to).catch(() => {});
    throw new PluginActionError('The renamed code did not pass the checks, so nothing changed.', problems);
  }
  await up.server.install(to, { keepExisting: true });
  if (!(await up.whenLoaded(to))) {
    await up.server.trash(to.slice('user.'.length)).catch(() => {});
    throw new PluginActionError(`The renamed plugin did not load${up.loadErrorFor(to) ? ` (${up.loadErrorFor(to)})` : ''}, so nothing changed.`);
  }
  let projectPlaces = 0;
  up.history.transact('Rename plugin', (draft) => {
    projectPlaces = renamePluginId(draft, from, to);
  });
  const savedThings = up.presets.renamePlugin(from, to);
  up.meta.rename(from, to);
  await up.server.trash(row.folder as string);
  await up.refresh();
  return { from, to, projectPlaces, savedThings };
}
