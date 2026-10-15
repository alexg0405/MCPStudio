/**
 * Derived audio kept in the Origin Private File System between sessions: `derived/<key>.pcm`, one
 * file per time-stretched clip copy (16-bit PCM, core/io/pcm16.ts), so a long song is stretched once
 * per file and tempo rather than once per session. A cache, not storage: anything can be deleted
 * and is made again. When the folder is over its cap, the files used least recently go first.
 */

export interface DerivedStore {
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Removes everything (and returns how many files went). */
  clear(): Promise<number>;
  /** Files and bytes kept. */
  usage(): Promise<{ files: number; bytes: number }>;
}

const DIR = 'derived';
/** 4 GB: about thirty 5-minute songs stretched at two tempos each. */
export const DERIVED_CAP_BYTES = 4 * 1024 ** 3;

/** A file name for any key: [A-Za-z0-9._-] stay, everything else becomes ~xx (so names never collide). */
export function derivedFileName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}.pcm`;
}

const isNotFound = (e: unknown) => {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
};

export function createOpfsDerivedStore(opts: { capBytes?: number } = {}): DerivedStore {
  const cap = opts.capBytes ?? DERIVED_CAP_BYTES;
  let dirP: Promise<FileSystemDirectoryHandle> | null = null;
  const dir = () => (dirP ??= navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(DIR, { create: true })));
  /** Reads mark a file as used (its time), so trimming keeps what is played. */
  const used = new Map<string, number>();
  let trimming: Promise<void> | null = null;

  const list = async () => {
    const d = await dir();
    const files: Array<{ name: string; size: number; time: number }> = [];
    for await (const [name, handle] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.pcm')) continue;
      const f = await (handle as FileSystemFileHandle).getFile();
      files.push({ name, size: f.size, time: used.get(name) ?? f.lastModified });
    }
    return files;
  };

  const trim = async () => {
    const files = (await list()).sort((a, b) => a.time - b.time);
    let total = files.reduce((n, f) => n + f.size, 0);
    const d = await dir();
    for (const f of files) {
      if (total <= cap) break;
      await d.removeEntry(f.name).catch(() => {});
      used.delete(f.name);
      total -= f.size;
    }
  };

  return {
    async has(key) {
      try {
        await (await dir()).getFileHandle(derivedFileName(key));
        return true;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
    async get(key) {
      const name = derivedFileName(key);
      try {
        const file = await (await (await dir()).getFileHandle(name)).getFile();
        used.set(name, Date.now());
        return new Uint8Array(await file.arrayBuffer());
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async put(key, bytes) {
      const name = derivedFileName(key);
      const handle = await (await dir()).getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      try {
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
      } catch (e) {
        await w.abort().catch(() => {});
        throw e;
      }
      used.set(name, Date.now());
      trimming ??= trim().finally(() => (trimming = null));
      await trimming;
    },
    async clear() {
      const d = await dir();
      const files = await list();
      for (const f of files) await d.removeEntry(f.name).catch(() => {});
      used.clear();
      return files.length;
    },
    async usage() {
      const files = await list();
      return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
    },
  };
}
