/**
 * The `.agproj` project file: a zip with
 *
 *   meta.json               { format, appVersion, savedAt }
 *   project.json            the Project document (deflated)
 *   view.json               window layout and editor state, opaque at this layer (deflated)
 *   samples/<sha256>.<ext>  original encoded sample bytes (stored, no compression)
 *
 * Plugin code is never embedded: plugins are referenced by id + version. Samples are keyed by
 * content hash, so a sample used by several channels is stored once.
 */
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';
import { SCHEMA_VERSION, type Project } from '../model/types';
import { MIGRATIONS, SchemaError, migrateProject, repairProject, type Migration } from '../schema/migrate';
import { isSha256Hex } from './hash';
import { readZipEntry, readZipIndex, type RangeReader, type ZipEntry } from './zip-index';

/** Version of the zip layout (not the project schema, which is project.schemaVersion). */
export const PROJECT_FILE_FORMAT = 1;
export const PROJECT_FILE_EXTENSION = '.agproj';
export const PROJECT_FILE_MIME = 'application/x-agstudio-project';

export interface ProjectFileMeta {
  format: number;
  appVersion: string;
  /** ISO 8601. */
  savedAt: string;
}

/** An embedded sample's original file bytes and lowercase extension (no dot). */
export interface EmbeddedSample {
  ext: string;
  bytes: Uint8Array;
}

export interface WriteProjectFileInput {
  project: Project;
  /** Any JSON-serializable value. */
  view: unknown;
  /** Samples to embed, keyed by SHA-256 hex of their bytes. */
  samples: ReadonlyMap<string, EmbeddedSample>;
  appVersion: string;
  now?: Date;
}

export interface ProjectFileContents {
  /** Migrated to the current schema and repaired. */
  project: Project;
  /** Parsed view.json, or null when it was missing or unreadable. */
  view: unknown;
  meta: ProjectFileMeta;
  /** Embedded samples by hash. Their bytes are not verified here (hashing is async). */
  samples: Map<string, EmbeddedSample>;
  /** Plain-language notes about what had to be fixed or assumed while opening. */
  repairs: string[];
  /** The project's schemaVersion in the file. */
  migratedFrom: number;
}

export type ProjectFileErrorCode =
  | 'not-a-project-file'
  | 'damaged'
  | 'missing-project'
  | 'invalid-json'
  | 'invalid-project'
  | 'newer-format'
  | 'newer-version'
  | 'unsupported-version';

/** Opening failed. `message` is written for the user; `cause` has the technical detail. */
export class ProjectFileError extends Error {
  readonly code: ProjectFileErrorCode;
  constructor(code: ProjectFileErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectFileError';
    this.code = code;
  }
}

const SAMPLE_ENTRY = /^samples\/([0-9a-fA-F]{64})\.([A-Za-z0-9]{1,10})$/;
const EXTENSION = /^[a-z0-9]{1,10}$/;
const JSON_ENTRIES = new Set(['meta.json', 'project.json', 'view.json']);
/** Guards against absurd (or hostile) sizes claimed by a damaged zip directory. */
const MAX_JSON_BYTES = 256 * 1024 * 1024;

/** Normalizes a file extension ("WAV", ".aif") to the stored form; null when unusable. */
export function normalizeSampleExt(ext: string): string | null {
  const e = ext.replace(/^\./, '').toLowerCase();
  return EXTENSION.test(e) ? e : null;
}

/** Zip entries carry DOS timestamps, which only cover 1980–2107 (fflate allows 1980–2099). */
function zipTime(now: Date): Date {
  const lo = Date.UTC(1980, 0, 2);
  const hi = Date.UTC(2099, 11, 30);
  const t = now.getTime();
  return new Date(Number.isFinite(t) ? Math.min(hi, Math.max(lo, t)) : lo);
}

/** Builds the zip. Deterministic for the same input and `now`. */
export function writeProjectFile(input: WriteProjectFileInput): Uint8Array {
  const now = input.now ?? new Date();
  const meta: ProjectFileMeta = {
    format: PROJECT_FILE_FORMAT,
    appVersion: input.appVersion,
    savedAt: now.toISOString(),
  };
  const json = (value: unknown, indent?: number) => strToU8(JSON.stringify(value ?? null, null, indent));
  const files: Zippable = {
    'meta.json': [json(meta, 2), { level: 6 }],
    'project.json': [json(input.project), { level: 6 }],
    'view.json': [json(input.view), { level: 6 }],
  };
  for (const hash of [...input.samples.keys()].sort()) {
    const sample = input.samples.get(hash) as EmbeddedSample;
    const ext = normalizeSampleExt(sample.ext);
    if (!isSha256Hex(hash)) throw new TypeError(`writeProjectFile: "${hash}" is not a SHA-256 hex hash.`);
    if (!ext) throw new TypeError(`writeProjectFile: "${sample.ext}" is not a valid sample extension.`);
    // Audio is already compressed or doesn't deflate well: store it as is.
    files[`samples/${hash}.${ext}`] = [sample.bytes, { level: 0 }];
  }
  return zipSync(files, { mtime: zipTime(now) });
}

function looksLikeZip(bytes: Uint8Array): boolean {
  // Local file header "PK\3\4", or the end-of-central-directory record of an empty archive.
  return (
    bytes.length >= 22 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
  );
}

function parseJson(bytes: Uint8Array): unknown {
  let text = strFromU8(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM from hand-edited files
  return JSON.parse(text);
}

const DAMAGED = "This project file is damaged and can't be opened.";

/**
 * Reads, migrates and repairs a project file. Throws ProjectFileError (with a message meant for the
 * user) when the bytes aren't a project file, project.json is missing or unreadable, or the file
 * comes from a newer AGstudio. A damaged meta.json or view.json is tolerated and reported in
 * `repairs`.
 */
export function readProjectFile(
  bytes: Uint8Array,
  opts: { migrations?: readonly (Migration | undefined)[] } = {},
): ProjectFileContents {
  if (!looksLikeZip(bytes)) {
    throw new ProjectFileError(
      'not-a-project-file',
      `This file is not an AGstudio project (${PROJECT_FILE_EXTENSION}).`,
    );
  }
  let entries: Record<string, Uint8Array>;
  let oversized = false;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (JSON_ENTRIES.has(f.name)) {
          if (f.originalSize > MAX_JSON_BYTES) oversized = true;
          return !oversized;
        }
        return SAMPLE_ENTRY.test(f.name);
      },
    });
  } catch (cause) {
    throw new ProjectFileError('damaged', DAMAGED, cause);
  }
  if (oversized) throw new ProjectFileError('damaged', DAMAGED);
  const doc = interpretEntries(entries['meta.json'], entries['project.json'], entries['view.json'], opts);
  const samples = new Map<string, EmbeddedSample>();
  for (const [name, data] of Object.entries(entries)) {
    const m = SAMPLE_ENTRY.exec(name);
    if (!m) continue;
    const hash = (m[1] as string).toLowerCase();
    if (!samples.has(hash)) samples.set(hash, { ext: (m[2] as string).toLowerCase(), bytes: data });
  }
  return { ...doc, samples };
}

/** An embedded sample in a project file that hasn't been read yet. */
export interface LazySample {
  ext: string;
  /** Bytes in the file. */
  size: number;
  read(): Promise<Uint8Array>;
}

export type ProjectFileIndex = Omit<ProjectFileContents, 'samples'> & {
  /** Embedded samples by hash, read one at a time (a big project never sits in memory whole). */
  samples: Map<string, LazySample>;
};

/**
 * Like readProjectFile, from a file read a range at a time (File.slice): the directory and the JSON
 * entries now, each embedded sample when its `read` is called.
 */
export async function readProjectFileIndex(
  read: RangeReader,
  size: number,
  opts: { migrations?: readonly (Migration | undefined)[] } = {},
): Promise<ProjectFileIndex> {
  if (!looksLikeZip(await read(0, Math.min(size, 22)))) {
    throw new ProjectFileError(
      'not-a-project-file',
      `This file is not an AGstudio project (${PROJECT_FILE_EXTENSION}).`,
    );
  }
  let index: ZipEntry[];
  try {
    index = await readZipIndex(read, size);
  } catch (cause) {
    throw new ProjectFileError('damaged', DAMAGED, cause);
  }
  const json = async (name: string) => {
    const e = index.find((x) => x.name === name);
    if (!e) return undefined;
    if (e.size > MAX_JSON_BYTES) throw new ProjectFileError('damaged', DAMAGED);
    try {
      return await readZipEntry(read, e);
    } catch (cause) {
      throw new ProjectFileError('damaged', DAMAGED, cause);
    }
  };
  const doc = interpretEntries(await json('meta.json'), await json('project.json'), await json('view.json'), opts);
  const samples = new Map<string, LazySample>();
  for (const e of index) {
    const m = SAMPLE_ENTRY.exec(e.name);
    if (!m) continue;
    const hash = (m[1] as string).toLowerCase();
    if (!samples.has(hash))
      samples.set(hash, { ext: (m[2] as string).toLowerCase(), size: e.size, read: () => readZipEntry(read, e) });
  }
  return { ...doc, samples };
}

/**
 * An embedded sample to write: its hash, extension and a way to get its bytes (null: missing),
 * with the extension they were stored under when that is the one to use.
 */
export interface SampleSource {
  hash: string;
  ext: string;
  read(): Promise<{ bytes: Uint8Array; ext?: string } | null>;
}

/**
 * Writes the zip a piece at a time (big projects): the JSON entries, then each sample, read only
 * when it is written and passed on in 1 MB pieces, so memory holds one sample at most. Readers of
 * writeProjectFile's files read these too. Returns the hashes whose bytes were missing (left out).
 */
export async function writeProjectFileStream(
  input: Omit<WriteProjectFileInput, 'samples'> & { samples: readonly SampleSource[] },
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<{ missing: string[] }> {
  const now = zipTime(input.now ?? new Date());
  const meta: ProjectFileMeta = {
    format: PROJECT_FILE_FORMAT,
    appVersion: input.appVersion,
    savedAt: (input.now ?? new Date()).toISOString(),
  };
  let chain: Promise<void> = Promise.resolve();
  let error: unknown = null;
  let resolveEnd!: () => void;
  const ended = new Promise<void>((r) => (resolveEnd = r));
  const zip = new Zip((err, chunk, final) => {
    if (err) error ??= err;
    if (chunk.byteLength > 0) {
      const copy = chunk.slice();
      chain = chain.then(() => write(copy)).catch((e: unknown) => {
        error ??= e;
      });
    }
    if (final) void chain.then(resolveEnd);
  });
  const flushed = async () => {
    await chain;
    if (error) throw error;
  };
  const json = (name: string, value: unknown, indent?: number) => {
    const f = new ZipDeflate(name, { level: 6 });
    f.mtime = now;
    zip.add(f);
    f.push(strToU8(JSON.stringify(value ?? null, null, indent)), true);
  };
  json('meta.json', meta, 2);
  json('project.json', input.project);
  json('view.json', input.view);
  await flushed();
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const s of [...input.samples].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))) {
    if (seen.has(s.hash)) continue;
    seen.add(s.hash);
    if (!isSha256Hex(s.hash)) throw new TypeError(`writeProjectFile: "${s.hash}" is not a SHA-256 hex hash.`);
    const got = await s.read();
    if (!got) {
      missing.push(s.hash);
      continue;
    }
    const ext = normalizeSampleExt(got.ext ?? s.ext);
    if (!ext) throw new TypeError(`writeProjectFile: "${got.ext ?? s.ext}" is not a valid sample extension.`);
    const bytes = got.bytes;
    // Audio is already compressed or doesn't deflate well: stored as is.
    const f = new ZipPassThrough(`samples/${s.hash}.${ext}`);
    f.mtime = now;
    zip.add(f);
    const step = 1 << 20;
    if (bytes.length === 0) f.push(bytes, true);
    for (let o = 0; o < bytes.length; o += step) {
      f.push(bytes.subarray(o, Math.min(bytes.length, o + step)), o + step >= bytes.length);
      await flushed();
    }
  }
  zip.end();
  await ended;
  await flushed();
  return { missing };
}

/** meta.json, project.json and view.json into the document (shared by both readers). */
function interpretEntries(
  metaBytes: Uint8Array | undefined,
  projectBytes: Uint8Array | undefined,
  viewBytes: Uint8Array | undefined,
  opts: { migrations?: readonly (Migration | undefined)[] },
): Omit<ProjectFileContents, 'samples'> {
  const repairs: string[] = [];
  const meta = readMeta(metaBytes, repairs);
  if (!projectBytes) {
    throw new ProjectFileError('missing-project', 'This project file is incomplete: it contains no project data.');
  }
  let json: unknown;
  try {
    json = parseJson(projectBytes);
  } catch (cause) {
    throw new ProjectFileError('invalid-json', "This project file is damaged: its project data can't be read.", cause);
  }
  let migrated: { project: Project; migratedFrom: number };
  try {
    migrated = migrateProject(json, opts.migrations ?? MIGRATIONS);
  } catch (cause) {
    throw schemaFailure(cause);
  }
  const repaired = repairProject(migrated.project);
  repairs.push(...repaired.repairs);

  let view: unknown = null;
  if (viewBytes) {
    try {
      view = parseJson(viewBytes);
    } catch {
      repairs.push("The saved window layout couldn't be read and was reset.");
    }
  }
  return { project: repaired.project, view, meta, repairs, migratedFrom: migrated.migratedFrom };
}

function readMeta(bytes: Uint8Array | undefined, repairs: string[]): ProjectFileMeta {
  const fallback: ProjectFileMeta = { format: PROJECT_FILE_FORMAT, appVersion: 'unknown', savedAt: '' };
  if (!bytes) {
    repairs.push('The file had no format information; it was read as a version 1 project file.');
    return fallback;
  }
  let raw: unknown;
  try {
    raw = parseJson(bytes);
  } catch {
    raw = null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    repairs.push("The file's format information was damaged; it was read as a version 1 project file.");
    return fallback;
  }
  const m = raw as Record<string, unknown>;
  const format = m.format;
  if (typeof format === 'number' && Number.isInteger(format) && format > PROJECT_FILE_FORMAT) {
    throw new ProjectFileError(
      'newer-format',
      `This project was saved by a newer version of AGstudio (file format ${format}). Update AGstudio to open it.`,
    );
  }
  if (format !== PROJECT_FILE_FORMAT) {
    repairs.push("The file's format version was missing or invalid; it was read as a version 1 project file.");
  }
  return {
    format: PROJECT_FILE_FORMAT,
    appVersion: typeof m.appVersion === 'string' ? m.appVersion : fallback.appVersion,
    savedAt: typeof m.savedAt === 'string' ? m.savedAt : fallback.savedAt,
  };
}

function schemaFailure(cause: unknown): ProjectFileError {
  if (cause instanceof SchemaError && cause.code === 'too-new') {
    return new ProjectFileError(
      'newer-version',
      `This project was saved by a newer version of AGstudio (project version ${cause.version ?? '?'}; this version ` +
        `opens up to ${SCHEMA_VERSION}). Update AGstudio to open it.`,
      cause,
    );
  }
  if (cause instanceof SchemaError && cause.code === 'too-old') {
    return new ProjectFileError(
      'unsupported-version',
      `This project uses an old project version (${cause.version ?? '?'}) that this version of AGstudio can't convert.`,
      cause,
    );
  }
  return new ProjectFileError('invalid-project', "This project file is damaged: its project data isn't valid.", cause);
}
