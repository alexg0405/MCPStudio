/** The public types of OPFS storage (`opfs.ts` re-exports them): the blob store, autosaves and storage errors. */
import type { BlobStat } from '@core/gc/plan';

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

/** The two files an autosave alternates between, so one valid copy always survives an interrupted save. */
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

/** Where the storage's directories are rooted; asked for on every call so nothing touches the browser early. */
export type RootDirectory = () => Promise<FileSystemDirectoryHandle>;
