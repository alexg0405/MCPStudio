import { randomId } from '@core/model/ids';
import { idbDel, idbGet, idbSet, isIdbAvailable } from '@platform/idb';

/**
 * Recently opened or saved project files. The list and the FileSystemFileHandles live in IndexedDB
 * (handles survive reloads only there). A handle's key also links autosaves and reloads back to the
 * file, so Save keeps writing to the same place.
 */
export interface RecentFile {
  key: string;
  /** File name including the extension. */
  name: string;
  /** ISO 8601. */
  usedAt: string;
}

const LIST = 'recent-files';
const MAX = 10;
const handleKey = (key: string) => `file-handle:${key}`;

let cache: RecentFile[] = [];
const listeners = new Set<() => void>();

function publish(list: RecentFile[]): void {
  cache = list;
  for (const fn of listeners) fn();
}

/** The last list read or written (for synchronous menus); call `loadRecentFiles()` once at startup. */
export function recentFiles(): readonly RecentFile[] {
  return cache;
}

export function subscribeRecentFiles(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function readList(): Promise<RecentFile[]> {
  if (!isIdbAvailable()) return [];
  try {
    const list = await idbGet<RecentFile[]>(LIST);
    return Array.isArray(list) ? list.filter((f) => typeof f?.key === 'string' && typeof f.name === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadRecentFiles(): Promise<readonly RecentFile[]> {
  publish(await readList());
  return cache;
}

export async function fileHandle(key: string): Promise<FileSystemFileHandle | null> {
  if (!isIdbAvailable()) return null;
  try {
    return (await idbGet<FileSystemFileHandle>(handleKey(key))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Puts a file at the top of the list (the same file keeps its key) and returns its key. Never throws:
 * without IndexedDB the file just isn't remembered.
 */
export async function rememberFile(handle: FileSystemFileHandle): Promise<string | null> {
  if (!isIdbAvailable()) return null;
  try {
    const list = await readList();
    let key: string | null = null;
    for (const f of list) {
      const h = await fileHandle(f.key);
      if (h && (await h.isSameEntry(handle).catch(() => false))) {
        key = f.key;
        break;
      }
    }
    key ??= randomId('file');
    await idbSet(handleKey(key), handle);
    const next = [{ key, name: handle.name, usedAt: new Date().toISOString() }, ...list.filter((f) => f.key !== key)];
    for (const old of next.splice(MAX)) await idbDel(handleKey(old.key)).catch(() => {});
    await idbSet(LIST, next);
    publish(next);
    return key;
  } catch (e) {
    console.warn('Could not remember the file:', e);
    return null;
  }
}

export async function forgetFile(key: string): Promise<void> {
  if (!isIdbAvailable()) return;
  try {
    const next = (await readList()).filter((f) => f.key !== key);
    await idbSet(LIST, next);
    await idbDel(handleKey(key));
    publish(next);
  } catch {
    /* nothing to forget */
  }
}
