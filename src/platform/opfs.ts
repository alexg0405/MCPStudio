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
 */
import { isSha256Hex, sha256Hex } from '@core/io/hash';
import { normalizeSampleExt } from '@core/io/project-file';
import type { BlobStat } from '@core/gc/plan';
import { writeFile as writeHandle } from './fs-access';

export interface StoredBlob {
  ext: string;
  bytes: Uint8Array;
}

export interface BlobInfo {
  hash: string;
  ext: string;
}

/**
 * Content-addressed sample storage. Callers guarantee `hash` is the SHA-256 of `bytes`. A stored copy
 * with the right hash and size is trusted (writes are atomic, so only media corruption could break
 * that); stored copies are not re-hashed on every read.
 */
export interface BlobStore {
  /** Stores the bytes unless a blob with this hash (and size) is already there. */
  putBlob(hash: string, ext: string, bytes: Uint8Array): Promise<void>;
  /** `ext` is a lookup hint (the SampleRef's extension); the result has the stored extension. */
  getBlob(hash: string, ext?: string): Promise<StoredBlob | null>;
  hasBlob(hash: string, ext?: string): Promise<boolean>;
  deleteBlob(hash: string): Promise<void>;
  listBlobs(): Promise<BlobInfo[]>;
  /** Like `listBlobs` with each file's size and last write time (clean-up of unused audio needs both). */
  blobStats?(): Promise<BlobStat[]>;
  /** The stored file itself, read lazily (`slice(a, b).arrayBuffer()` reads that part only): for songs too long to hold whole. */
  getFile?(hash: string, ext?: string): Promise<{ ext: string; file: Blob } | null>;
}

export type AutosaveSlot = 'a' | 'b';

export interface AutosaveMeta {
  sessionId: string;
  projectId: string;
  title: string;
  /** ISO 8601. */
  savedAt: string;
  /** The session ended normally (no recovery needed). */
  clean: boolean;
  slot: AutosaveSlot;
  /** Key of the file handle the project was opened from or saved to (IndexedDB). */
  fileKey?: string;
}

export interface AutosaveStore {
  writeAutosave(sessionId: string, slot: AutosaveSlot, data: Uint8Array, meta: AutosaveMeta): Promise<void>;
  /** The newest slot whose data matches its recorded size and hash, or null. */
  readAutosave(sessionId: string): Promise<{ data: Uint8Array; meta: AutosaveMeta } | null>;
  /** One entry per session (its newest slot with intact data), newest first. */
  listAutosaves(): Promise<AutosaveMeta[]>;
  deleteAutosave(sessionId: string): Promise<void>;
  /** Marks the session's newest slot clean (normal shutdown). */
  markAutosaveClean(sessionId: string): Promise<void>;
}

export type StorageErrorCode = 'unavailable' | 'quota' | 'invalid' | 'io';

/** A storage failure with a message meant for the user; `cause` has the browser's error. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code;
  }
}

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

const BLOBS = 'blobs';
const AUTOSAVE = 'autosave';
const BLOB_NAME = /^([0-9a-f]{64})\.([a-z0-9]{1,10})$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SLOTS: readonly AutosaveSlot[] = ['a', 'b'];

/** What the slot meta file holds: the caller's meta plus what makes the slot verifiable. */
interface SlotRecord extends AutosaveMeta {
  v: 1;
  size: number;
  sha256: string;
}

const errorName = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined);
const isNotFound = (e: unknown) => errorName(e) === 'NotFoundError' || errorName(e) === 'TypeMismatchError';

function toStorageError(action: string, e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const name = errorName(e);
  if (name === 'QuotaExceededError') {
    return new StorageError(
      'quota',
      `Browser storage is full, so AGstudio couldn't ${action}. Free up disk space or remove old projects.`,
      e,
    );
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new StorageError(
      'unavailable',
      `Browser storage is blocked (private browsing or site settings), so AGstudio couldn't ${action}.`,
      e,
    );
  }
  const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
  return new StorageError('io', `AGstudio couldn't ${action} in browser storage${detail}`, e);
}

async function guard<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toStorageError(action, e);
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  await writeHandle(await dir.getFileHandle(name, { create: true }), bytes);
}

async function fileOf(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

async function readBytes(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  const file = await fileOf(dir, name);
  return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

/** The subdirectory, or null when it doesn't exist. */
async function getDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function ensureDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

function assertHash(hash: string): void {
  if (!isSha256Hex(hash)) throw new StorageError('invalid', `"${hash}" is not a SHA-256 hex hash.`);
}

/** Validates a blob's key for any BlobStore; returns the normalized extension. Throws StorageError. */
export function checkBlobKey(hash: string, ext: string): string {
  assertHash(hash);
  const e = normalizeSampleExt(ext);
  if (!e) throw new StorageError('invalid', `"${ext}" is not a valid file extension.`);
  return e;
}

function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) throw new StorageError('invalid', `"${id}" is not a valid session id.`);
}

function parseSlotRecord(bytes: Uint8Array | null, slot: AutosaveSlot): SlotRecord | null {
  if (!bytes) return null;
  try {
    const r = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SlotRecord>;
    const ok =
      r.v === 1 &&
      r.slot === slot &&
      typeof r.sessionId === 'string' &&
      typeof r.projectId === 'string' &&
      typeof r.title === 'string' &&
      typeof r.savedAt === 'string' &&
      typeof r.clean === 'boolean' &&
      (r.fileKey === undefined || typeof r.fileKey === 'string') &&
      typeof r.size === 'number' &&
      isSha256Hex(r.sha256);
    return ok ? (r as SlotRecord) : null;
  } catch {
    return null;
  }
}

function toMeta(r: SlotRecord, sessionId: string): AutosaveMeta {
  const meta: AutosaveMeta = {
    sessionId,
    projectId: r.projectId,
    title: r.title,
    savedAt: r.savedAt,
    clean: r.clean,
    slot: r.slot,
  };
  if (r.fileKey !== undefined) meta.fileKey = r.fileKey;
  return meta;
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
};
const newestFirst = (a: { savedAt: string }, b: { savedAt: string }) => time(b.savedAt) - time(a.savedAt);

export interface OpfsStorageOptions {
  /** The directory everything lives under (default: the OPFS root). Tests pass a scratch directory. */
  root?: () => Promise<FileSystemDirectoryHandle>;
}

/** One autosave slot file, for clean-up: which session and slot, how big, and a way to read it. */
export interface AutosaveFile {
  sessionId: string;
  slot: AutosaveSlot;
  size: number;
  read(): Promise<Uint8Array>;
}

export type OpfsStorage = Required<BlobStore> &
  AutosaveStore & {
    /** Every autosave slot's data file, valid or not (the meta that vouches for it is not consulted). */
    autosaveFiles(): Promise<AutosaveFile[]>;
  };

/** Creates an OPFS-backed blob and autosave store. Nothing touches the browser until a method is called. */
export function createOpfsStorage(opts: OpfsStorageOptions = {}): OpfsStorage {
  const root = async () => {
    if (opts.root) return opts.root();
    if (!isOpfsAvailable()) {
      throw new StorageError('unavailable', 'This browser has no origin private file system (OPFS) storage.');
    }
    return navigator.storage.getDirectory();
  };
  /** hash → stored extensions (normally one); filled by directory scans and by our own writes. */
  const extsOf = new Map<string, string[]>();
  let scanned = false;
  const remember = (hash: string, ext: string) => {
    const exts = extsOf.get(hash);
    if (!exts) extsOf.set(hash, [ext]);
    else if (!exts.includes(ext)) exts.push(ext);
  };

  async function scanBlobs(dir: FileSystemDirectoryHandle): Promise<BlobInfo[]> {
    const found: BlobInfo[] = [];
    extsOf.clear();
    for await (const [name, handle] of dir.entries()) {
      const m = handle.kind === 'file' ? BLOB_NAME.exec(name) : null;
      if (!m) continue; // also skips in-progress swap files
      const info = { hash: m[1] as string, ext: m[2] as string };
      remember(info.hash, info.ext);
      found.push(info);
    }
    scanned = true;
    return found;
  }

  /** Finds the blob's file: the hinted extension first, then the cache, then (when needed) a scan. */
  async function findBlob(hash: string, hint?: string): Promise<{ file: File; ext: string } | null> {
    const dir = await getDir(await root(), BLOBS);
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
    if (hinted === undefined || !scanned) {
      await scanBlobs(dir);
      return attempt(extsOf.get(hash)?.[0]);
    }
    return null;
  }

  async function slotRecords(dir: FileSystemDirectoryHandle): Promise<SlotRecord[]> {
    const records: SlotRecord[] = [];
    for (const slot of SLOTS) {
      const r = parseSlotRecord(await readBytes(dir, `${slot}.json`), slot);
      if (r) records.push(r);
    }
    return records.sort(newestFirst);
  }

  /**
   * The newest slot whose data matches the size and SHA-256 its meta records. listAutosaves,
   * readAutosave and markAutosaveClean all use this one rule (autosaves are thin, so hashing is cheap).
   */
  async function newestValid(dir: FileSystemDirectoryHandle): Promise<{ record: SlotRecord; data: Uint8Array } | null> {
    for (const record of await slotRecords(dir)) {
      const data = await readBytes(dir, `${record.slot}.agproj`);
      if (data && data.byteLength === record.size && (await sha256Hex(data)) === record.sha256) return { record, data };
    }
    return null;
  }

  async function sessionDir(sessionId: string): Promise<FileSystemDirectoryHandle | null> {
    assertSessionId(sessionId);
    const autosave = await getDir(await root(), AUTOSAVE);
    return autosave ? getDir(autosave, sessionId) : null;
  }

  return {
    putBlob: (hash, ext, bytes) =>
      guard('store a sample', async () => {
        const e = checkBlobKey(hash, ext);
        const existing = await findBlob(hash, e);
        // Same hash and size: the same content (under any extension), so there is nothing to do.
        if (existing?.file.size === bytes.byteLength) return;
        const dir = await ensureDir(await root(), BLOBS);
        await writeFile(dir, `${hash}.${e}`, bytes);
        if (existing && existing.ext !== e) {
          // Replace a damaged copy stored under another extension.
          await dir.removeEntry(`${hash}.${existing.ext}`).catch(() => {});
        }
        extsOf.set(hash, [e]);
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
        const dir = await getDir(await root(), BLOBS);
        if (!dir) return;
        // A GC pass lists (scans) once and then deletes many, so trust the index when it knows the
        // hash; otherwise rescan, since another tab may have added the blob after our last scan.
        if (!scanned || !extsOf.has(hash)) await scanBlobs(dir);
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
        const dir = await getDir(await root(), BLOBS);
        if (!dir) return [];
        return (await scanBlobs(dir)).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      }),

    blobStats: () =>
      guard('measure samples', async () => {
        const dir = await getDir(await root(), BLOBS);
        if (!dir) return [];
        const out: BlobStat[] = [];
        for await (const [name, handle] of dir.entries()) {
          const m = handle.kind === 'file' ? BLOB_NAME.exec(name) : null;
          if (!m) continue;
          try {
            const file = await (handle as FileSystemFileHandle).getFile();
            out.push({ hash: m[1] as string, ext: m[2] as string, size: file.size, modifiedAt: file.lastModified });
          } catch (e) {
            if (!isNotFound(e)) throw e; // deleted by another tab while we looked
          }
        }
        return out.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      }),

    autosaveFiles: () =>
      guard('list autosaves', async () => {
        const autosave = await getDir(await root(), AUTOSAVE);
        if (!autosave) return [];
        const out: AutosaveFile[] = [];
        for await (const [name, handle] of autosave.entries()) {
          if (handle.kind !== 'directory' || !SESSION_ID.test(name)) continue;
          for (const slot of SLOTS) {
            try {
              const file = await fileOf(handle as FileSystemDirectoryHandle, `${slot}.agproj`);
              if (!file) continue;
              out.push({
                sessionId: name,
                slot,
                size: file.size,
                read: async () => new Uint8Array(await file.arrayBuffer()),
              });
            } catch (e) {
              if (!isNotFound(e)) throw e;
            }
          }
        }
        return out;
      }),

    writeAutosave: (sessionId, slot, data, meta) =>
      guard('autosave the project', async () => {
        if (!SLOTS.includes(slot)) throw new StorageError('invalid', `"${String(slot)}" is not an autosave slot.`);
        assertSessionId(sessionId);
        const dir = await ensureDir(await ensureDir(await root(), AUTOSAVE), sessionId);
        const record: SlotRecord = {
          sessionId,
          projectId: meta.projectId,
          title: meta.title,
          savedAt: meta.savedAt,
          clean: meta.clean,
          slot,
          ...(meta.fileKey === undefined ? {} : { fileKey: meta.fileKey }),
          v: 1,
          size: data.byteLength,
          sha256: await sha256Hex(data),
        };
        // Data first, then the meta that vouches for it: an interrupted save leaves this slot invalid
        // and the other slot (the previous save) intact.
        await writeFile(dir, `${slot}.agproj`, data);
        await writeFile(dir, `${slot}.json`, new TextEncoder().encode(JSON.stringify(record)));
      }),

    readAutosave: (sessionId) =>
      guard('read an autosave', async () => {
        const dir = await sessionDir(sessionId);
        const valid = dir ? await newestValid(dir) : null;
        return valid ? { data: valid.data, meta: toMeta(valid.record, sessionId) } : null;
      }),

    listAutosaves: () =>
      guard('list autosaves', async () => {
        const autosave = await getDir(await root(), AUTOSAVE);
        if (!autosave) return [];
        const metas: AutosaveMeta[] = [];
        for await (const [name, handle] of autosave.entries()) {
          if (handle.kind !== 'directory' || !SESSION_ID.test(name)) continue;
          try {
            const valid = await newestValid(handle);
            if (valid) metas.push(toMeta(valid.record, name));
          } catch {
            // A session deleted or half-written by another tab while we looked: skip it.
          }
        }
        return metas.sort(newestFirst);
      }),

    deleteAutosave: (sessionId) =>
      guard('delete an autosave', async () => {
        assertSessionId(sessionId);
        const autosave = await getDir(await root(), AUTOSAVE);
        if (!autosave) return;
        try {
          await autosave.removeEntry(sessionId, { recursive: true });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }),

    markAutosaveClean: (sessionId) =>
      guard('update an autosave', async () => {
        const dir = await sessionDir(sessionId);
        const r = dir ? (await newestValid(dir))?.record : undefined;
        if (!dir || !r || r.clean) return;
        await writeFile(dir, `${r.slot}.json`, new TextEncoder().encode(JSON.stringify({ ...r, clean: true })));
      }),
  };
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
