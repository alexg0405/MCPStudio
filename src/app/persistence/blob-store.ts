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

/**
 * How clean-up of unused audio (app/storage) keeps writers and readers safe. The store calls it around
 * every persistent write and lookup; with none installed (tests, no Web Locks) it does nothing.
 */
export interface BlobGuard {
  /** Runs `fn` while no blob can be deleted (a shared Web Lock; deletes take it exclusively). */
  hold<T>(fn: () => Promise<T>): Promise<T>;
  /** Marks a blob as in use right now, which keeps it for the grace period. Must finish before `hold` ends. */
  touch(hash: string): Promise<void>;
}

let installedGuard: BlobGuard | null = null;
/** Sets the guard every store without its own uses (the composition root does this once). */
export function installBlobGuard(guard: BlobGuard | null): void {
  installedGuard = guard;
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
export function createSampleStore(primary: BlobStore | null, opts: { guard?: BlobGuard } = {}): SampleStore {
  const guardOf = () => opts.guard ?? installedGuard;
  const memory = createMemoryBlobStore();
  const listeners = new Set<(error: unknown, hash: string) => void>();
  let isPrimaryDown = primary === null;
  let primaryError: unknown = null;
  const markPrimaryDown = (e: unknown) => {
    isPrimaryDown = true;
    primaryError = e;
  };

  /** A primary read; when the primary is unavailable it counts as empty (memory only from then on). */
  async function read<T>(op: (p: BlobStore) => Promise<T>, empty: T): Promise<T> {
    if (isPrimaryDown || !primary) return empty;
    try {
      return await op(primary);
    } catch (e) {
      if (!isUnavailable(e)) throw e;
      markPrimaryDown(e);
      return empty;
    }
  }

  return {
    get memoryOnly() {
      return isPrimaryDown;
    },
    onFallback(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async putBlob(hash, ext, bytes) {
      checkBlobKey(hash, ext);
      let error = primaryError;
      if (!isPrimaryDown && primary) {
        try {
          const guard = guardOf();
          // Written (or found already there) and marked in use before a delete can look at it.
          if (guard)
            await guard.hold(async () => {
              await primary.putBlob(hash, ext, bytes);
              await guard.touch(hash);
            });
          else await primary.putBlob(hash, ext, bytes);
          return;
        } catch (e) {
          if (e instanceof StorageError && e.code === 'invalid') throw e;
          if (isUnavailable(e)) markPrimaryDown(e);
          error = e;
        }
      }
      await memory.putBlob(hash, ext, bytes);
      if (primary) for (const fn of listeners) fn(error, hash);
    },
    async getBlob(hash, ext) {
      const inMemory = await memory.getBlob(hash);
      if (inMemory) return inMemory;
      const found = await read((p) => p.getBlob(hash, ext), null);
      // Reading is using it. (The bytes are already in hand, so only the mark needs the hold.)
      const guard = guardOf();
      if (found && guard) await guard.hold(() => guard.touch(hash));
      return found;
    },
    async getFile(hash, ext) {
      const inMemory = await memory.getBlob(hash);
      if (inMemory) return { ext: inMemory.ext, file: new Blob([inMemory.bytes as BlobPart]) };
      const found = await read(async (p) => (p.getFile ? await p.getFile(hash, ext) : null), null);
      const guard = guardOf();
      if (found && guard) await guard.hold(() => guard.touch(hash));
      return found;
    },
    async hasBlob(hash, ext) {
      if (await memory.hasBlob(hash)) return true;
      const guard = guardOf();
      // A "yes" is only true until a delete: marking it in use under the hold makes it stay true.
      if (!guard) return read((p) => p.hasBlob(hash, ext), false);
      return guard.hold(async () => {
        const has = await read((p) => p.hasBlob(hash, ext), false);
        if (has) await guard.touch(hash);
        return has;
      });
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
