/** Directory and file helpers for OPFS storage, and the translation of browser errors into `StorageError`. */
import { isSha256Hex } from '@core/io/hash';
import { normalizeSampleExt } from '@core/io/project-file';
import { writeFile as writeHandle } from './fs-access';
import { StorageError } from './opfs-types';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True for a name that is safe to use as an autosave session directory. */
export const isSessionId = (name: string): boolean => SESSION_ID_PATTERN.test(name);

const errorName = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined);

/** True for the error a missing file or directory gives (or a name that is the wrong kind of entry). */
export const isNotFound = (e: unknown): boolean =>
  errorName(e) === 'NotFoundError' || errorName(e) === 'TypeMismatchError';

/** A message the musician can act on: storage full, blocked, or a plain I/O failure (`action` is "store a sample"). */
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

/** Runs a storage operation and turns whatever it throws into a `StorageError` about `action`. */
export async function guard<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toStorageError(action, e);
  }
}

/** Writes `bytes` to `dir/name` (created if needed); the new content is swapped in atomically. */
export async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  await writeHandle(await dir.getFileHandle(name, { create: true }), bytes);
}

/** The file, or null when it doesn't exist. */
export async function fileOf(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The file's bytes, or null when it doesn't exist. */
export async function readBytes(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  const file = await fileOf(dir, name);
  return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

/** The subdirectory, or null when it doesn't exist. */
export async function getDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The subdirectory, created when it doesn't exist. */
export function ensureDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

export function assertHash(hash: string): void {
  if (!isSha256Hex(hash)) throw new StorageError('invalid', `"${hash}" is not a SHA-256 hex hash.`);
}

/** Validates a blob's key for any BlobStore; returns the normalized extension. Throws StorageError. */
export function checkBlobKey(hash: string, ext: string): string {
  assertHash(hash);
  const normalized = normalizeSampleExt(ext);
  if (!normalized) throw new StorageError('invalid', `"${ext}" is not a valid file extension.`);
  return normalized;
}

export function assertSessionId(id: string): void {
  if (!isSessionId(id)) throw new StorageError('invalid', `"${id}" is not a valid session id.`);
}
