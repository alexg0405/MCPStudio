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

export async function openTempFile(prefix: string): Promise<TempFile | null> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('tmp', { create: true });
    const name = `${prefix.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}-${++tempSeq}`;
    const handle = await dir.getFileHandle(name, { create: true });
    const sink = await openFileSink(handle);
    return {
      sink,
      file: () => handle.getFile(),
      remove: () => dir.removeEntry(name).catch(() => {}),
    };
  } catch {
    return null;
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
