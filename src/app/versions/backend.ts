import { isOpfsAvailable, opfsVersionFiles, type VersionFileStore } from '@platform/opfs';
import { idbKv, isKvAvailable, type GcKv } from '../storage/kv';

/** Where versions and project cards are kept: the app's IndexedDB `kv` store for records, OPFS for version files. */
export interface VersionBackend {
  kv: GcKv;
  files: VersionFileStore;
}

/** The real storage, or null when this browser has no private file system or no IndexedDB (nothing is then kept). */
export function defaultVersionBackend(): VersionBackend | null {
  if (!isOpfsAvailable() || !isKvAvailable()) return null;
  return { kv: idbKv, files: opfsVersionFiles() };
}
