import { createStore } from 'zustand/vanilla';
import { randomId } from '@core/model/ids';
import {
  ensurePermission,
  isAudioFileName,
  isFileSystemAccessSupported,
  listAudioFiles,
  pickDirectory,
  type AudioFileEntry,
} from '@platform/fs-access';
import { idbDel, idbGet, idbSet, isIdbAvailable } from '@platform/idb';

/**
 * The user's sample folders (FL's browser "extra search folders"). Directory handles live in
 * IndexedDB; after a reload Chrome usually needs the user to allow access again ("Reconnect").
 */
export { isAudioFileName, type AudioFileEntry };

export type FolderAccess = 'granted' | 'prompt' | 'denied';

export interface FolderState {
  key: string;
  name: string;
  access: FolderAccess;
  /** Audio files found (recursive, sorted by path); null until listed. */
  files: AudioFileEntry[] | null;
  loading: boolean;
  error?: string;
}

const LIST = 'sample-folders';
const handleKey = (key: string) => `sample-folder:${key}`;
/** Keeps one folder from holding the browser for minutes (the sample browser windows lists and analyzes them all). */
export const MAX_FILES_PER_FOLDER = 30000;

export const sampleFolders = createStore<{ folders: FolderState[]; loaded: boolean }>(() => ({
  folders: [],
  loaded: false,
}));

export function canPickFolders(): boolean {
  return isFileSystemAccessSupported();
}

function patch(key: string, change: Partial<FolderState>): void {
  sampleFolders.setState((s) => ({ folders: s.folders.map((f) => (f.key === key ? { ...f, ...change } : f)) }));
}

async function handleOf(key: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await idbGet<FileSystemDirectoryHandle>(handleKey(key))) ?? null;
  } catch {
    return null;
  }
}

async function list(key: string): Promise<void> {
  const dir = await handleOf(key);
  if (!dir) {
    patch(key, { error: 'This folder is no longer available.', loading: false });
    return;
  }
  patch(key, { loading: true, error: undefined });
  try {
    const files = await listAudioFiles(dir, { recursive: true });
    patch(key, {
      files: files.slice(0, MAX_FILES_PER_FOLDER),
      loading: false,
      ...(files.length > MAX_FILES_PER_FOLDER
        ? { error: `Showing the first ${MAX_FILES_PER_FOLDER} of ${files.length} files.` }
        : {}),
    });
  } catch (e) {
    patch(key, { loading: false, error: e instanceof Error ? e.message : String(e) });
  }
}

async function save(): Promise<void> {
  await idbSet(
    LIST,
    sampleFolders.getState().folders.map((f) => ({ key: f.key, name: f.name })),
  );
}

/** Reads the saved folders and lists the ones the browser still lets us read. */
export async function loadSampleFolders(): Promise<void> {
  if (!isIdbAvailable()) return sampleFolders.setState({ loaded: true });
  let saved: { key: string; name: string }[] = [];
  try {
    const raw = await idbGet<{ key: string; name: string }[]>(LIST);
    if (Array.isArray(raw)) saved = raw.filter((f) => typeof f?.key === 'string' && typeof f.name === 'string');
  } catch {
    /* no saved folders */
  }
  const folders: FolderState[] = [];
  for (const f of saved) {
    const dir = await handleOf(f.key);
    if (!dir) continue;
    const access: FolderAccess = (await ensurePermission(dir, 'read', false)) ? 'granted' : 'prompt';
    folders.push({ key: f.key, name: f.name, access, files: null, loading: false });
  }
  sampleFolders.setState({ folders, loaded: true });
  await Promise.all(folders.filter((f) => f.access === 'granted').map((f) => list(f.key)));
}

/** Asks for a folder and adds it (needs a user gesture). Resolves false on cancel. */
export async function addSampleFolder(): Promise<boolean> {
  const dir = await pickDirectory('samples', 'read');
  if (!dir) return false;
  for (const f of sampleFolders.getState().folders) {
    const h = await handleOf(f.key);
    if (h && (await h.isSameEntry(dir).catch(() => false))) {
      await list(f.key);
      return true;
    }
  }
  const key = randomId('dir');
  await idbSet(handleKey(key), dir);
  sampleFolders.setState((s) => ({
    folders: [...s.folders, { key, name: dir.name, access: 'granted', files: null, loading: true }],
  }));
  await save();
  await list(key);
  return true;
}

/** Asks the browser for access again (needs a user gesture), then lists the folder. */
export async function reconnectSampleFolder(key: string): Promise<boolean> {
  const dir = await handleOf(key);
  if (!dir) return false;
  const ok = await ensurePermission(dir, 'read', true);
  patch(key, { access: ok ? 'granted' : 'denied' });
  if (ok) await list(key);
  return ok;
}

export function refreshSampleFolder(key: string): Promise<void> {
  return list(key);
}

export async function removeSampleFolder(key: string): Promise<void> {
  sampleFolders.setState((s) => ({ folders: s.folders.filter((f) => f.key !== key) }));
  await save();
  await idbDel(handleKey(key)).catch(() => {});
}
