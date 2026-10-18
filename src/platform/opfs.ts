/**
 * Origin Private File System storage:
 *
 *   blobs/<sha256>.<ext>          sample blob store (content-addressed, original encoded bytes)
 *   autosave/<sessionId>/a.agproj  autosave slot A (+ a.json: its AutosaveMeta, size and SHA-256)
 *   autosave/<sessionId>/b.agproj  autosave slot B (+ b.json)
 *
 * Writes go through createWritable(), which swaps the file in atomically on close, so a crash leaves
 * the previous version. An autosave slot is valid when its data matches the size and hash recorded in
 * its meta file; the writer alternates slots so one valid copy always survives an interrupted save.
 *
 * This file is the public door and the composition; the blob store is `opfs-blobs.ts`, the autosaves
 * `opfs-autosave.ts`, the shared file helpers `opfs-files.ts` and the types `opfs-types.ts`.
 */
import { createAutosaveStorage } from './opfs-autosave';
import { createBlobStorage } from './opfs-blobs';
import {
  StorageError,
  type AutosaveStore,
  type BlobStore,
  type OpfsStorage,
  type OpfsStorageOptions,
} from './opfs-types';

export { checkBlobKey } from './opfs-files';
export {
  StorageError,
  type AutosaveFile,
  type AutosaveMeta,
  type AutosaveSlot,
  type AutosaveStore,
  type BlobInfo,
  type BlobStore,
  type OpfsStorage,
  type OpfsStorageOptions,
  type StorageErrorCode,
  type StoredBlob,
} from './opfs-types';

/** OPFS with createWritable() (Chrome 102+, Firefox 111+, Safari 17.4+); secure contexts only. */
export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function'
  );
}

/** Asks the browser not to evict our storage under pressure. Resolves false when refused or unsupported. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

/** Creates an OPFS-backed blob and autosave store. Nothing touches the browser until a method is called. */
export function createOpfsStorage(opts: OpfsStorageOptions = {}): OpfsStorage {
  const root = async () => {
    if (opts.root) return opts.root();
    if (!isOpfsAvailable()) {
      throw new StorageError('unavailable', 'This browser has no origin private file system (OPFS) storage.');
    }
    return navigator.storage.getDirectory();
  };
  return { ...createBlobStorage(root), ...createAutosaveStorage(root) };
}

let defaultStorage: OpfsStorage | null = null;

/** The app-wide store rooted at the OPFS root (created on first use). */
export function opfsStorage(): OpfsStorage {
  defaultStorage ??= createOpfsStorage();
  return defaultStorage;
}

export const putBlob: BlobStore['putBlob'] = (hash, ext, bytes) => opfsStorage().putBlob(hash, ext, bytes);
export const getBlob: BlobStore['getBlob'] = (hash, ext) => opfsStorage().getBlob(hash, ext);
export const hasBlob: BlobStore['hasBlob'] = (hash, ext) => opfsStorage().hasBlob(hash, ext);
export const deleteBlob: BlobStore['deleteBlob'] = (hash) => opfsStorage().deleteBlob(hash);
export const listBlobs: BlobStore['listBlobs'] = () => opfsStorage().listBlobs();
export const writeAutosave: AutosaveStore['writeAutosave'] = (sessionId, slot, data, meta) =>
  opfsStorage().writeAutosave(sessionId, slot, data, meta);
export const readAutosave: AutosaveStore['readAutosave'] = (sessionId) => opfsStorage().readAutosave(sessionId);
export const listAutosaves: AutosaveStore['listAutosaves'] = () => opfsStorage().listAutosaves();
export const deleteAutosave: AutosaveStore['deleteAutosave'] = (sessionId) => opfsStorage().deleteAutosave(sessionId);
export const markAutosaveClean: AutosaveStore['markAutosaveClean'] = (sessionId) =>
  opfsStorage().markAutosaveClean(sessionId);
