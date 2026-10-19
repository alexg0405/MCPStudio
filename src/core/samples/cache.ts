/**
 * The cache of analyses of a sample folder: one record per folder, file by file. A file counts as unchanged when its path,
 * size and modification time are the same (reading every file to hash it would cost more than analyzing it), and an
 * analysis made by another version of the analyzer is never used (`SAMPLE_ANALYSIS_VERSION`). Pure: the app keeps the
 * record in IndexedDB.
 *
 * The record never holds a content hash: a hash in a stored value would count as "this audio is in use" for the storage
 * clean-up (docs/architecture.md), and these files are not in the project's sample store at all.
 */
import { SAMPLE_ANALYSIS_VERSION, type SampleAnalysis } from './types';

/** What identifies a file for the cache. */
export interface FileIdentity {
  /** Path inside the folder, with `/`. */
  path: string;
  size: number;
  lastModified: number;
}

/** A folder's record: `files[path] = [size, lastModified, analysis]`. */
export interface FolderRecord {
  version: number;
  files: Record<string, [number, number, SampleAnalysis]>;
}

/** A folder record with no files yet, at the current analysis version. */
export const emptyRecord = (): FolderRecord => ({ version: SAMPLE_ANALYSIS_VERSION, files: {} });

/** A record read back from storage, or an empty one when it is missing, damaged, or from another version. */
export function readRecord(raw: unknown): FolderRecord {
  const r = raw as Partial<FolderRecord> | null;
  if (!r || typeof r !== 'object' || r.version !== SAMPLE_ANALYSIS_VERSION || !r.files || typeof r.files !== 'object') return emptyRecord();
  const files: FolderRecord['files'] = {};
  for (const [path, v] of Object.entries(r.files)) {
    if (!Array.isArray(v) || v.length !== 3) continue;
    const [size, mtime, a] = v as [unknown, unknown, SampleAnalysis | null];
    if (typeof size === 'number' && typeof mtime === 'number' && a && typeof a === 'object' && a.v === SAMPLE_ANALYSIS_VERSION && typeof a.kind === 'string')
      files[path] = [size, mtime, a];
  }
  return { version: SAMPLE_ANALYSIS_VERSION, files };
}

/** The cached analysis of a file, or null when there is none for exactly this file. */
export function lookup(record: FolderRecord, file: FileIdentity): SampleAnalysis | null {
  const hit = record.files[file.path];
  return hit && hit[0] === file.size && hit[1] === file.lastModified ? hit[2] : null;
}

/** Splits a folder's files into the ones the cache knows and the ones to analyze. */
export function reconcile<T extends FileIdentity>(record: FolderRecord, files: readonly T[]): { hits: Map<string, SampleAnalysis>; misses: T[] } {
  const hits = new Map<string, SampleAnalysis>();
  const misses: T[] = [];
  for (const f of files) {
    const a = lookup(record, f);
    if (a) hits.set(f.path, a);
    else misses.push(f);
  }
  return { hits, misses };
}

/** Adds a result to a record the caller owns (in place: a folder of thousands of files would copy the record each time). */
export function store(record: FolderRecord, file: FileIdentity, analysis: SampleAnalysis): void {
  record.files[file.path] = [file.size, file.lastModified, analysis];
}

/** The record without the files that are no longer in the folder. */
export function prune(record: FolderRecord, files: readonly FileIdentity[]): FolderRecord {
  const keep = new Set(files.map((f) => f.path));
  const out: FolderRecord['files'] = {};
  for (const [path, v] of Object.entries(record.files)) if (keep.has(path)) out[path] = v;
  return { version: record.version, files: out };
}
