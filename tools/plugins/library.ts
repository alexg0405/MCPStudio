import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_PLUGIN_FILE_BYTES } from '../../src/core/plugin-bundle/rules.ts';
import { DraftError, exists, renameFolder, stampNow, type PluginPaths } from './shared.ts';

/**
 * Looking after the plugin folders on disk: what is installed, switched off or in the trash, and moving a plugin between
 * them. Nothing here deletes for good: "delete" moves a plugin to `plugins/_trash/`, "disable" to `plugins/_disabled/`
 * (discovery ignores folders starting with "_", so both stop loading at once), and both can be undone.
 */

/** Where a plugin folder is: loaded, switched off, or deleted (recoverable). */
export type PluginPlace = 'installed' | 'disabled' | 'trash';

/** One plugin folder: its name, the plugin id its code declares (null when none is found), its files and when it changed. */
export interface FolderInfo {
  folder: string;
  id: string | null;
  files: { path: string; bytes: number }[];
  /** Milliseconds since 1970 of the newest file. */
  modified: number;
}

/** Everything the manager shows from disk. */
export interface PluginListing {
  installed: FolderInfo[];
  disabled: FolderInfo[];
  trash: FolderInfo[];
}

/** One file as read for export, copy or rename. */
export interface FolderFile {
  path: string;
  content: string;
}

type Body = Record<string, unknown>;

/** The most files read from one folder (a plugin has at most 8; the rest of a hand-made folder is ignored). */
const MAX_FILES_READ = 16;
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SOURCE_FILE = /\.(ts|tsx|dsp|md)$/i;
const DECLARED_ID = /['"`](user\.[a-z][a-z0-9-]{1,40})['"`]/;

/** A folder name from a request, checked so it can never point outside the plugin folders. */
export function safeFolderName(value: unknown, what = 'plugin folder'): string {
  if (typeof value !== 'string' || !FOLDER_NAME.test(value) || value.includes('..') || value.startsWith('_'))
    throw new DraftError(`That is not a valid ${what} name.`);
  return value;
}

/** The place a request names. */
export function placeOf(value: unknown): PluginPlace {
  if (value === 'installed' || value === 'disabled' || value === 'trash') return value;
  throw new DraftError('Say where the plugin is: installed, disabled or trash.');
}

/** The folder that holds plugins in a place. */
export function placeDir(paths: PluginPaths, place: PluginPlace): string {
  return place === 'installed' ? paths.plugins : place === 'disabled' ? paths.disabled : paths.trash;
}

async function readFolder(dir: string, folder: string): Promise<FolderInfo> {
  const files: FolderInfo['files'] = [];
  let id: string | null = null;
  let modified = 0;
  for (const entry of await readdir(join(dir, folder), { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const info = await stat(join(dir, folder, entry.name));
    files.push({ path: entry.name, bytes: info.size });
    modified = Math.max(modified, info.mtimeMs);
    if (id === null && /\.(ts|tsx)$/.test(entry.name) && info.size <= MAX_PLUGIN_FILE_BYTES) {
      id = DECLARED_ID.exec(await readFile(join(dir, folder, entry.name), 'utf8'))?.[1] ?? null;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { folder, id, files, modified: Math.round(modified) };
}

async function listPlace(dir: string, skipUnderscore: boolean): Promise<FolderInfo[]> {
  if (!(await exists(dir))) return [];
  const folders: FolderInfo[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || (skipUnderscore && entry.name.startsWith('_'))) continue;
    folders.push(await readFolder(dir, entry.name));
  }
  return folders.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** POST /list: the plugin folders by place. */
export async function listPlugins(paths: PluginPaths): Promise<PluginListing> {
  const [installed, disabled, trash] = await Promise.all([
    listPlace(paths.plugins, true),
    listPlace(paths.disabled, false),
    listPlace(paths.trash, false),
  ]);
  return { installed, disabled, trash };
}

/** POST /files: the source files of one folder, for export, duplicate and rename. Names the files it left out. */
export async function readPluginFiles(paths: PluginPaths, body: Body): Promise<{ files: FolderFile[]; skipped: string[] }> {
  const place = placeOf(body.where ?? 'installed');
  const folder = safeFolderName(body.folder);
  const dir = join(placeDir(paths, place), folder);
  if (!(await exists(dir))) throw new DraftError('There is no such plugin folder.', 404);
  const files: FolderFile[] = [];
  const skipped: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const size = entry.isFile() ? (await stat(join(dir, entry.name))).size : 0;
    const keep = entry.isFile() && SOURCE_FILE.test(entry.name) && size <= MAX_PLUGIN_FILE_BYTES && files.length < MAX_FILES_READ;
    if (!keep) {
      skipped.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
      continue;
    }
    files.push({ path: entry.name, content: await readFile(join(dir, entry.name), 'utf8') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

/** Moves `from` to `to` (making the parent folder), refusing when `to` is taken. */
async function moveInto(from: string, to: string, takenMessage: string): Promise<void> {
  if (await exists(to)) throw new DraftError(takenMessage, 409);
  await mkdir(join(to, '..'), { recursive: true });
  await renameFolder(from, to);
}

/** POST /trash: moves an installed (or switched-off, `where: "disabled"`) plugin to plugins/_trash/<folder>-<time>. */
export async function trashPlugin(paths: PluginPaths, body: Body): Promise<{ entry: string }> {
  const folder = safeFolderName(body.folder);
  const place = body.where === 'disabled' ? 'disabled' : 'installed';
  const from = join(placeDir(paths, place), folder);
  if (!(await exists(from))) throw new DraftError('There is no such plugin folder.', 404);
  const entry = `${folder}-${stampNow()}`;
  await moveInto(from, join(paths.trash, entry), 'That plugin is already in the trash.');
  return { entry };
}

/** The folder a trash entry came from: "tape-stop-20260101T120000Z" → "tape-stop". */
export function folderOfTrashEntry(entry: string): string {
  return entry.replace(/-\d{8}T\d{6}Z$/, '');
}

/** POST /restore: moves a trash entry back to plugins/<folder> (refused while that folder exists). */
export async function restorePlugin(paths: PluginPaths, body: Body): Promise<{ folder: string }> {
  const entry = safeFolderName(body.entry, 'trash entry');
  const from = join(paths.trash, entry);
  if (!(await exists(from))) throw new DraftError('There is no such plugin in the trash.', 404);
  const folder = safeFolderName(folderOfTrashEntry(entry));
  await moveInto(from, join(paths.plugins, folder), `There already is a plugin in plugins/${folder}. Rename or remove it first.`);
  return { folder };
}

/** POST /disable: moves an installed plugin to plugins/_disabled/<folder>, where it is not loaded. */
export async function disablePlugin(paths: PluginPaths, body: Body): Promise<{ folder: string }> {
  const folder = safeFolderName(body.folder);
  const from = join(paths.plugins, folder);
  if (!(await exists(from))) throw new DraftError('There is no such plugin folder.', 404);
  await moveInto(from, join(paths.disabled, folder), 'A switched-off plugin with that folder name already exists.');
  return { folder };
}

/** POST /enable: moves a switched-off plugin back to plugins/<folder>. */
export async function enablePlugin(paths: PluginPaths, body: Body): Promise<{ folder: string }> {
  const folder = safeFolderName(body.folder);
  const from = join(paths.disabled, folder);
  if (!(await exists(from))) throw new DraftError('There is no such switched-off plugin.', 404);
  await moveInto(from, join(paths.plugins, folder), `There already is a plugin in plugins/${folder}. Rename or remove it first.`);
  return { folder };
}

/** Shows a folder in the computer's file manager (a stand-in is passed in tests). */
export type FolderOpener = (path: string) => Promise<void>;

/** The system's way of showing a folder: Finder, Explorer or the desktop's file manager. */
export const openWithSystem: FolderOpener = (path) =>
  new Promise((resolve, reject) => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(command, [path], { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.unref();
    // `explorer` exits with 1 even when it worked, so only a failure to start counts.
    setTimeout(resolve, 150);
  });

/** POST /open-folder: shows plugins/ (or one plugin's folder) in the file manager. */
export async function openPluginFolder(
  paths: PluginPaths,
  body: Body,
  open: FolderOpener = openWithSystem,
): Promise<{ path: string }> {
  const place = placeOf(body.where ?? 'installed');
  const dir = body.folder === undefined ? placeDir(paths, place) : join(placeDir(paths, place), safeFolderName(body.folder));
  if (!(await exists(dir))) throw new DraftError('That folder does not exist.', 404);
  await open(dir);
  return { path: dir };
}
