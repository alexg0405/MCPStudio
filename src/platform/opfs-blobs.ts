/**
 * The sample blob store in OPFS: `blobs/<sha256>.<ext>`, content-addressed, original encoded bytes.
 *
 * A blob is found by its hash; its extension is only a hint (the same audio may have been stored under
 * another one). The store keeps an index of hash → extensions that directory scans and its own writes
 * fill in, so most lookups cost one file open.
 */
import type { BlobStat } from '@core/gc/plan';
import { isSha256Hex } from '@core/io/hash';
import { normalizeSampleExt } from '@core/io/project-file';
import { assertHash, checkBlobKey, ensureDir, fileOf, getDir, guard, isNotFound, writeFile } from './opfs-files';
import type { BlobInfo, BlobStore, RootDirectory } from './opfs-types';

const BLOBS_DIRECTORY = 'blobs';
/** A blob file name: 64 hex digits of SHA-256, a dot, the extension. */
const BLOB_NAME = /^([0-9a-f]{64})\.([a-z0-9]{1,10})$/;

const byHash = (a: { hash: string }, b: { hash: string }): number => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

/** Creates the blob store; nothing touches the browser until a method is called. */
export function createBlobStorage(root: RootDirectory): Required<BlobStore> {
  /** hash → stored extensions (normally one); filled by directory scans and by our own writes. */
  const extsOf = new Map<string, string[]>();
  let hasScanned = false;

  const remember = (hash: string, ext: string) => {
    const exts = extsOf.get(hash);
    if (!exts) extsOf.set(hash, [ext]);
    else if (!exts.includes(ext)) exts.push(ext);
  };

  /** Lists the directory and rebuilds the index from it. */
  async function scanBlobs(dir: FileSystemDirectoryHandle): Promise<BlobInfo[]> {
    const found: BlobInfo[] = [];
    extsOf.clear();
    for await (const [name, handle] of dir.entries()) {
      const match = handle.kind === 'file' ? BLOB_NAME.exec(name) : null;
      if (!match) continue; // also skips in-progress swap files
      const info = { hash: match[1] as string, ext: match[2] as string };
      remember(info.hash, info.ext);
      found.push(info);
    }
    hasScanned = true;
    return found;
  }

  /** Finds the blob's file: the hinted extension first, then the cache, then (when needed) a scan. */
  async function findBlob(hash: string, hint?: string): Promise<{ file: File; ext: string } | null> {
    const dir = await getDir(await root(), BLOBS_DIRECTORY);
    if (!dir) return null;
    const tried = new Set<string>();
    const attempt = async (ext: string | undefined) => {
      if (!ext || tried.has(ext)) return null;
      tried.add(ext);
      const file = await fileOf(dir, `${hash}.${ext}`);
      return file ? { file, ext } : null;
    };
    // Hints come from project data: ignore anything that isn't a valid extension.
    const hinted = hint === undefined ? undefined : (normalizeSampleExt(hint) ?? undefined);
    const found = (await attempt(hinted)) ?? (await attempt(extsOf.get(hash)?.[0]));
    if (found) {
      remember(hash, found.ext); // e.g. written by another tab after our last scan
      return found;
    }
    extsOf.delete(hash);
    // With a hint, one scan per store finds blobs saved under another extension; without one, a miss
    // rescans because another tab may have added the blob since.
    if (hinted === undefined || !hasScanned) {
      await scanBlobs(dir);
      return attempt(extsOf.get(hash)?.[0]);
    }
    return null;
  }

  return {
    putBlob: (hash, ext, bytes) =>
      guard('store a sample', async () => {
        const normalizedExt = checkBlobKey(hash, ext);
        const existing = await findBlob(hash, normalizedExt);
        // Same hash and size: the same content (under any extension), so there is nothing to do.
        if (existing?.file.size === bytes.byteLength) return;
        const dir = await ensureDir(await root(), BLOBS_DIRECTORY);
        await writeFile(dir, `${hash}.${normalizedExt}`, bytes);
        if (existing && existing.ext !== normalizedExt) {
          // Replace a damaged copy stored under another extension.
          await dir.removeEntry(`${hash}.${existing.ext}`).catch(() => {});
        }
        extsOf.set(hash, [normalizedExt]);
      }),

    getBlob: (hash, ext) =>
      guard('read a sample', async () => {
        if (!isSha256Hex(hash)) return null;
        const found = await findBlob(hash, ext);
        return found ? { ext: found.ext, bytes: new Uint8Array(await found.file.arrayBuffer()) } : null;
      }),

    getFile: (hash, ext) =>
      guard('read a sample', async () => {
        if (!isSha256Hex(hash)) return null;
        const found = await findBlob(hash, ext);
        return found ? { ext: found.ext, file: found.file } : null;
      }),

    hasBlob: (hash, ext) =>
      guard('look up a sample', async () => isSha256Hex(hash) && (await findBlob(hash, ext)) !== null),

    deleteBlob: (hash) =>
      guard('delete a sample', async () => {
        assertHash(hash);
        const dir = await getDir(await root(), BLOBS_DIRECTORY);
        if (!dir) return;
        // A GC pass lists (scans) once and then deletes many, so trust the index when it knows the
        // hash; otherwise rescan, since another tab may have added the blob after our last scan.
        if (!hasScanned || !extsOf.has(hash)) await scanBlobs(dir);
        for (const ext of extsOf.get(hash) ?? []) {
          try {
            await dir.removeEntry(`${hash}.${ext}`);
          } catch (e) {
            if (!isNotFound(e)) throw e;
          }
        }
        extsOf.delete(hash);
      }),

    listBlobs: () =>
      guard('list samples', async () => {
        const dir = await getDir(await root(), BLOBS_DIRECTORY);
        if (!dir) return [];
        return (await scanBlobs(dir)).sort(byHash);
      }),

    blobStats: () =>
      guard('measure samples', async () => {
        const dir = await getDir(await root(), BLOBS_DIRECTORY);
        if (!dir) return [];
        const stats: BlobStat[] = [];
        for await (const [name, handle] of dir.entries()) {
          const match = handle.kind === 'file' ? BLOB_NAME.exec(name) : null;
          if (!match) continue;
          try {
            const file = await (handle as FileSystemFileHandle).getFile();
            stats.push({
              hash: match[1] as string,
              ext: match[2] as string,
              size: file.size,
              modifiedAt: file.lastModified,
            });
          } catch (e) {
            if (!isNotFound(e)) throw e; // deleted by another tab while we looked
          }
        }
        return stats.sort(byHash);
      }),
  };
}
