import {
  StorageError,
  checkBlobKey,
  isOpfsAvailable,
  opfsStorage,
  type BlobInfo,
  type BlobStore,
  type StoredBlob,
} from '@platform/opfs';

/**
 * The app's sample store: OPFS when available, with an in-memory fallback so a session keeps
 * working (samples play, project files still embed them) when browser storage is missing, blocked
 * or full. Blobs that only live in memory are lost on reload, which is why `onFallback` exists.
 */
export interface SampleStore extends BlobStore {
  /** True when nothing persistent backs the store (any more): new samples last until reload. */
  readonly memoryOnly: boolean;
  /**
   * Called for each sample that had to be kept in memory because the persistent store failed or
   * became unavailable (not when there was no persistent store to begin with). Returns an unsubscribe
   * function.
   */
  onFallback(fn: (error: unknown, hash: string) => void): () => void;
}

const byHash = (a: BlobInfo, b: BlobInfo) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
const isUnavailable = (e: unknown) => e instanceof StorageError && e.code === 'unavailable';

/** A BlobStore in memory (tests, and the fallback layer). Bytes are copied in and out. */
export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, StoredBlob>();
  return {
    async putBlob(hash, ext, bytes) {
      const e = checkBlobKey(hash, ext);
      if (!blobs.has(hash)) blobs.set(hash, { ext: e, bytes: bytes.slice() });
    },
    async getBlob(hash) {
      const b = blobs.get(hash);
      return b ? { ext: b.ext, bytes: b.bytes.slice() } : null;
    },
    async hasBlob(hash) {
      return blobs.has(hash);
    },
    async deleteBlob(hash) {
      blobs.delete(hash);
    },
    async listBlobs() {
      return [...blobs].map(([hash, b]) => ({ hash, ext: b.ext })).sort(byHash);
    },
  };
}

/**
 * Layers `primary` (normally OPFS; null for none) over memory. A write the primary refuses (quota,
 * I/O) keeps the blob in memory and notifies `onFallback` listeners. A primary that turns out to be
 * unavailable (e.g. OPFS blocked in a private window) is dropped for the rest of the session, on reads
 * as well as writes. Invalid input still throws.
 */
export function createSampleStore(primary: BlobStore | null): SampleStore {
  const memory = createMemoryBlobStore();
  const listeners = new Set<(error: unknown, hash: string) => void>();
  let down = primary === null;
  let downError: unknown = null;
  const goDown = (e: unknown) => {
    down = true;
    downError = e;
  };

  /** A primary read; when the primary is unavailable it counts as empty (memory only from then on). */
  async function read<T>(op: (p: BlobStore) => Promise<T>, empty: T): Promise<T> {
    if (down || !primary) return empty;
    try {
      return await op(primary);
    } catch (e) {
      if (!isUnavailable(e)) throw e;
      goDown(e);
      return empty;
    }
  }

  return {
    get memoryOnly() {
      return down;
    },
    onFallback(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async putBlob(hash, ext, bytes) {
      checkBlobKey(hash, ext);
      let error = downError;
      if (!down && primary) {
        try {
          await primary.putBlob(hash, ext, bytes);
          return;
        } catch (e) {
          if (e instanceof StorageError && e.code === 'invalid') throw e;
          if (isUnavailable(e)) goDown(e);
          error = e;
        }
      }
      await memory.putBlob(hash, ext, bytes);
      if (primary) for (const fn of listeners) fn(error, hash);
    },
    async getBlob(hash, ext) {
      return (await memory.getBlob(hash)) ?? read((p) => p.getBlob(hash, ext), null);
    },
    async hasBlob(hash, ext) {
      return (await memory.hasBlob(hash)) || read((p) => p.hasBlob(hash, ext), false);
    },
    async deleteBlob(hash) {
      await memory.deleteBlob(hash);
      await read((p) => p.deleteBlob(hash), undefined);
    },
    async listBlobs() {
      const all = new Map<string, BlobInfo>();
      for (const b of await read((p) => p.listBlobs(), [] as BlobInfo[])) all.set(b.hash, b);
      for (const b of await memory.listBlobs()) if (!all.has(b.hash)) all.set(b.hash, b);
      return [...all.values()].sort(byHash);
    },
  };
}

let shared: SampleStore | null = null;

/**
 * The app-wide sample store (OPFS-backed when the browser has OPFS), used when a function is called
 * without a `store`. A composition root that creates its own store (createSampleStore(opfsStorage()))
 * should pass it to every call: each store has its own memory layer.
 */
export function defaultSampleStore(): SampleStore {
  shared ??= createSampleStore(isOpfsAvailable() ? opfsStorage() : null);
  return shared;
}
