/**
 * Files written a piece at a time (long exports, big projects): to a File System Access handle, to
 * a temporary file in the Origin Private File System, or to memory as parts. A sink can go back and
 * write over earlier bytes (a header whose sizes are known only at the end).
 */
import { unsharedBytes } from '@core/io/bytes';

export interface ByteSink {
  /** Bytes written so far (the end of the file). */
  readonly size: number;
  write(bytes: Uint8Array): Promise<void>;
  /** Writes over bytes already written, at `position` (the file doesn't grow). */
  writeAt(position: number, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Drops what was written (a cancelled export leaves the previous file, or none). */
  abort(): Promise<void>;
}

/** Writes through File System Access as it goes; the browser swaps the file in on close. */
export async function openFileSink(handle: FileSystemFileHandle): Promise<ByteSink> {
  const w = await handle.createWritable();
  let size = 0;
  return {
    get size() {
      return size;
    },
    async write(bytes) {
      if (bytes.byteLength === 0) return;
      await w.write(unsharedBytes(bytes));
      size += bytes.byteLength;
    },
    async writeAt(position, bytes) {
      await w.write({ type: 'write', position, data: unsharedBytes(bytes) });
      await w.seek(size);
    },
    close: () => w.close(),
    abort: () => w.abort().catch(() => {}),
  };
}

/** A sink in memory as parts (no copy into one big array until asked). */
export interface MemorySink extends ByteSink {
  /** The parts, in order (a Blob made of them can be kept on disk by the browser). */
  parts(): Uint8Array[];
  /** One array with everything (small files and tests). */
  bytes(): Uint8Array;
}

export function memorySink(): MemorySink {
  const parts: Uint8Array[] = [];
  let size = 0;
  return {
    get size() {
      return size;
    },
    async write(bytes) {
      if (bytes.byteLength === 0) return;
      parts.push(bytes);
      size += bytes.byteLength;
    },
    async writeAt(position, bytes) {
      let o = 0;
      for (const p of parts) {
        const a = Math.max(position, o);
        const b = Math.min(position + bytes.byteLength, o + p.byteLength);
        if (a < b) p.set(bytes.subarray(a - position, b - position), a - o);
        o += p.byteLength;
      }
    },
    close: async () => {},
    abort: async () => {
      parts.length = 0;
      size = 0;
    },
    parts: () => parts,
    bytes() {
      if (parts.length === 1) return parts[0] as Uint8Array;
      const out = new Uint8Array(size);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.byteLength;
      }
      return out;
    },
  };
}

/** A temporary file in OPFS (`tmp/`), read back as a File; null where OPFS isn't available. */
export interface TempFile {
  sink: ByteSink;
  /** After the sink is closed: the file (read it in slices). */
  file(): Promise<File>;
  remove(): Promise<void>;
}

let tempSeq = 0;

const TEMP_DIR = 'tmp';
const TEMP_LOCK_PREFIX = 'agstudio:tmp:';
const hasLocks = () => typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
/** Without Web Locks a temp file can't be told from one in use: only ones this old are swept. */
const TEMP_MAX_AGE_MS = 24 * 3600 * 1000;

/** Holds a lock named for the file until the returned function is called (the browser also releases it when the tab goes). */
async function holdTempLock(name: string): Promise<() => void> {
  if (!hasLocks()) return () => {};
  let release: () => void = () => {};
  await new Promise<void>((resolve) => {
    void navigator.locks
      .request(TEMP_LOCK_PREFIX + name, { mode: 'exclusive' }, () => {
        resolve();
        return new Promise<void>((r) => (release = r));
      })
      .catch(resolve);
  });
  return () => release();
}

export async function openTempFile(prefix: string): Promise<TempFile | null> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(TEMP_DIR, { create: true });
    const name = `${prefix.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}-${++tempSeq}`;
    // Taken before the file exists, so a sweep in another tab never sees it unprotected.
    const release = await holdTempLock(name);
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      const sink = await openFileSink(handle);
      return {
        sink,
        file: () => handle.getFile(),
        remove: async () => {
          await dir.removeEntry(name).catch(() => {});
          release();
        },
      };
    } catch (e) {
      release();
      throw e;
    }
  } catch {
    return null;
  }
}

/**
 * Removes temporary files that no tab is using any more (a tab closed or crashed in the middle of a
 * stems export leaves a file as big as one stem). Call at startup. Returns how many were removed.
 */
export async function sweepTempFiles(): Promise<number> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return 0;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(TEMP_DIR).catch(() => null);
    if (!dir) return 0;
    const names: string[] = [];
    for await (const [name, handle] of dir.entries()) if (handle.kind === 'file') names.push(name);
    let removed = 0;
    for (const name of names) {
      let free = false;
      if (hasLocks()) {
        // The lock is ours to take only when its owner is gone.
        await navigator.locks.request(TEMP_LOCK_PREFIX + name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock) return;
          free = true;
          await dir.removeEntry(name).catch(() => {
            free = false;
          });
        });
      } else {
        const at = Number(/-(\d{10,})-\d+$/.exec(name)?.[1]);
        if (Number.isFinite(at) && Date.now() - at > TEMP_MAX_AGE_MS) free = await dir.removeEntry(name).then(() => true, () => false);
      }
      if (free) removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Downloads parts as one file (a Blob of parts: they aren't copied into one array first). */
export function downloadParts(name: string, parts: readonly Uint8Array[], mime: string): void {
  const url = URL.createObjectURL(new Blob(parts.map((p) => unsharedBytes(p)), { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoking right away can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
