import { isSha256Hex } from '@core/io/hash';
import { normalizeSampleExt } from '@core/io/project-file';
import {
  StorageError,
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
  /** True when nothing persistent backs the store (every sample lasts until reload). */
  readonly memoryOnly: boolean;
  /** Called when a sample could only be kept in memory; returns an unsubscribe function. */
  onFallback(fn: (error: unknown, hash: string) => void): () => void;
}

const byHash = (a: BlobInfo, b: BlobInfo) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

function checkedExt(hash: string, ext: string): string {
  if (!isSha256Hex(hash)) throw new StorageError('invalid', `"${hash}" is not a SHA-256 hex hash.`);
  const e = normalizeSampleExt(ext);
  if (!e) throw new StorageError('invalid', `"${ext}" is not a valid file extension.`);
  return e;
}

/** A BlobStore in memory (tests, and the fallback layer). Bytes are copied in and out. */
export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, StoredBlob>();
  return {
    async putBlob(hash, ext, bytes) {
      const e = checkedExt(hash, ext);
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
 * Layers `primary` (normally OPFS; null for none) over memory. A failed write to `primary` keeps the
 * blob in memory and notifies `onFallback` listeners; invalid input still throws.
 */
export function createSampleStore(primary: BlobStore | null): SampleStore {
  const memory = createMemoryBlobStore();
  const listeners = new Set<(error: unknown, hash: string) => void>();
  return {
    memoryOnly: primary === null,
    onFallback(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async putBlob(hash, ext, bytes) {
      if (!primary) return memory.putBlob(hash, ext, bytes);
      try {
        await primary.putBlob(hash, ext, bytes);
      } catch (e) {
        if (e instanceof StorageError && e.code === 'invalid') throw e;
        await memory.putBlob(hash, ext, bytes);
        for (const fn of listeners) fn(e, hash);
      }
    },
    async getBlob(hash, ext) {
      return (await memory.getBlob(hash)) ?? (primary ? primary.getBlob(hash, ext) : null);
    },
    async hasBlob(hash, ext) {
      return (await memory.hasBlob(hash)) || (primary !== null && (await primary.hasBlob(hash, ext)));
    },
    async deleteBlob(hash) {
      await memory.deleteBlob(hash);
      await primary?.deleteBlob(hash);
    },
    async listBlobs() {
      const all = new Map<string, BlobInfo>();
      for (const b of primary ? await primary.listBlobs() : []) all.set(b.hash, b);
      for (const b of await memory.listBlobs()) if (!all.has(b.hash)) all.set(b.hash, b);
      return [...all.values()].sort(byHash);
    },
  };
}

let shared: SampleStore | null = null;

/** The app-wide sample store (OPFS-backed when the browser has OPFS). */
export function defaultSampleStore(): SampleStore {
  shared ??= createSampleStore(isOpfsAvailable() ? opfsStorage() : null);
  return shared;
}
