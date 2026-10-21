/**
 * The `.agproj` project file: a zip with
 *
 *   meta.json               { format, appVersion, savedAt }
 *   project.json            the Project document (deflated)
 *   view.json               window layout and editor state, opaque at this layer (deflated)
 *   samples/<sha256>.<ext>  original encoded sample bytes (stored, no compression)
 *   plugins/<id>.agplugin   optional: a plugin bundle (core/plugin-bundle) the project uses, only when the
 *                           musician chose to share the song with its own plugins
 *
 * Plugin code is not embedded by default: plugins are referenced by id + version. Samples are keyed by
 * content hash, so a sample used by several channels is stored once. Readers that do not know the
 * `plugins/` entries (older versions) skip them.
 */
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough, zipSync, type Zippable } from 'fflate';
import { SCHEMA_VERSION, type Project } from '../model/types';
import { MIGRATIONS, SchemaError, migrateProject, repairProject, type Migration } from '../schema/migrate';
import { collectHashes } from '../gc/refs';
import { isSha256Hex } from './hash';
import { projectJson } from './project-json';
import { readZipEntry, readZipIndex, type RangeReader, type ZipEntry } from './zip-index';

/** Version of the zip layout (not the project schema, which is project.schemaVersion). */
export const PROJECT_FILE_FORMAT = 1;
/** The file name ending of AGstudio project files. */
export const PROJECT_FILE_EXTENSION = '.agproj';
/** The media type of AGstudio project files. */
export const PROJECT_FILE_MIME = 'application/x-agstudio-project';
/** A project file stays under this (fflate writes no zip64, so offsets and sizes are 32 bits). */
export const ZIP_MAX_BYTES = 0xffff_0000;

/**
 * What a project file's `meta.json` says: the zip layout version, the app version that saved it and when (ISO 8601).
 */
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

/**
 * Everything a project file is written from: the project, the editor view state, the samples to embed (by SHA-256 hash)
 * and the app version.
 */
export interface WriteProjectFileInput {
  project: Project;
  /** Any JSON-serializable value. */
  view: unknown;
  /** Samples to embed, keyed by SHA-256 hex of their bytes. */
  samples: ReadonlyMap<string, EmbeddedSample>;
  /** Plugin bundles to embed (`.agplugin` bytes), keyed by plugin id. Left out: none are embedded. */
  plugins?: ReadonlyMap<string, Uint8Array>;
  appVersion: string;
  now?: Date;
}

/**
 * What opening a project file gives back: the project (migrated and repaired), the editor view state, the file's meta,
 * the embedded samples and notes about anything that had to be fixed.
 */
export interface ProjectFileContents {
  /** Migrated to the current schema and repaired. */
  project: Project;
  /** Parsed view.json, or null when it was missing or unreadable. */
  view: unknown;
  meta: ProjectFileMeta;
  /** Embedded samples by hash. Their bytes are not verified here (hashing is async). */
  samples: Map<string, EmbeddedSample>;
  /** Embedded plugin bundles by plugin id (`.agplugin` bytes, not checked here: reading a bundle checks it). */
  plugins: Map<string, Uint8Array>;
  /** Plain-language notes about what had to be fixed or assumed while opening. */
  repairs: string[];
  /** The project's schemaVersion in the file. */
  migratedFrom: number;
}

/** Why a project file could not be opened, for telling the user apart from other errors. */
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
const PLUGIN_ENTRY = /^plugins\/(user\.[a-z][a-z0-9-]{1,40})\.agplugin$/;
/** A project carries at most this many plugin bundles, each at most this big (a bundle itself is limited to 1 MB). */
export const MAX_EMBEDDED_PLUGINS = 32;
const MAX_EMBEDDED_PLUGIN_BYTES = 1024 * 1024;
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

/**
 * The entries of the zip and the timestamp they carry: everything `writeProjectFile` puts in the file before the
 * compression, which is the part that must happen where the document is (it reads the project). Zipping them is
 * `zipSync(files, { mtime })`, on this thread or, for an autosave, in a Worker (app/persistence/zip-async.ts), with
 * the same bytes either way.
 */
export interface ProjectFileParts {
  files: Zippable;
  mtime: Date;
}

/**
 * The files a project zip is made of (meta, project, view and one per sample), compressed and ready to zip, without
 * zipping them.
 */
export function projectFileParts(input: WriteProjectFileInput): ProjectFileParts {
  const now = input.now ?? new Date();
  const meta: ProjectFileMeta = {
    format: PROJECT_FILE_FORMAT,
    appVersion: input.appVersion,
    savedAt: now.toISOString(),
  };
  const json = (value: unknown, indent?: number) => strToU8(JSON.stringify(value ?? null, null, indent));
  const files: Zippable = {
    'meta.json': [json(meta, 2), { level: 6 }],
    'project.json': [strToU8(projectJson(input.project)), { level: 6 }],
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
  for (const [id, bytes] of pluginEntries(input.plugins)) files[`plugins/${id}.agplugin`] = [bytes, { level: 0 }];
  return { files, mtime: zipTime(now) };
}

/** The plugin bundles to write, sorted by id; an id that is not a user plugin id is a programming error. */
function pluginEntries(plugins: ReadonlyMap<string, Uint8Array> | undefined): [string, Uint8Array][] {
  const entries = [...(plugins ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [id] of entries) {
    if (!PLUGIN_ENTRY.test(`plugins/${id}.agplugin`)) throw new TypeError(`writeProjectFile: "${id}" is not a user plugin id.`);
  }
  if (entries.length > MAX_EMBEDDED_PLUGINS) throw new TypeError('writeProjectFile: too many plugins to embed.');
  return entries;
}

/** Zips the parts (the compression of `writeProjectFile`, on its own so a Worker can run it). */
export function zipProjectFileParts(parts: ProjectFileParts): Uint8Array {
  return zipSync(parts.files, { mtime: parts.mtime });
}

/** Builds the zip. Deterministic for the same input and `now`. */
export function writeProjectFile(input: WriteProjectFileInput): Uint8Array {
  return zipProjectFileParts(projectFileParts(input));
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
        if (PLUGIN_ENTRY.test(f.name)) return f.originalSize <= MAX_EMBEDDED_PLUGIN_BYTES;
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
  const plugins = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    const m = PLUGIN_ENTRY.exec(name);
    if (m && plugins.size < MAX_EMBEDDED_PLUGINS) plugins.set(m[1] as string, data);
  }
  return { ...doc, samples, plugins };
}

/**
 * Every sample hash a project file mentions (its project.json and view.json text, and the names of
 * its embedded samples), without migrating or validating anything. Null when the zip can't be read.
 * Used to decide which stored audio an autosave still needs.
 */
export function projectFileHashes(bytes: Uint8Array): Set<string> | null {
  if (!looksLikeZip(bytes)) return null;
  try {
    const out = new Set<string>();
    const entries = unzipSync(bytes, {
      filter: (f) => {
        if (SAMPLE_ENTRY.test(f.name)) collectHashes(f.name, out); // the name says it; no need to unpack the audio
        return JSON_ENTRIES.has(f.name);
      },
    });
    for (const data of Object.values(entries)) collectHashes(strFromU8(data), out);
    return out;
  } catch {
    return null;
  }
}

/** An embedded sample in a project file that hasn't been read yet. */
export interface LazySample {
  ext: string;
  /** Bytes in the file. */
  size: number;
  read(): Promise<Uint8Array>;
}

/**
 * Like `ProjectFileContents`, but with the samples left in the file to be read one at a time instead of all held in
 * memory.
 */
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
  // Plugin bundles are small (at most 1 MB each): read now, so the open flow can offer them without another trip to the file.
  const plugins = new Map<string, Uint8Array>();
  for (const e of index) {
    const m = PLUGIN_ENTRY.exec(e.name);
    if (!m || plugins.size >= MAX_EMBEDDED_PLUGINS || e.size > MAX_EMBEDDED_PLUGIN_BYTES) continue;
    try {
      plugins.set(m[1] as string, await readZipEntry(read, e));
    } catch {
      // A damaged bundle is skipped; the project itself still opens.
    }
  }
  return { ...doc, samples, plugins };
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

/** Samples are handed to the zip in pieces of this many bytes, so memory holds one piece of one sample at a time. */
const SAMPLE_PIECE_BYTES = 1 << 20;
/** Room kept per entry for its zip headers when checking that the file will fit its size limit. */
const ENTRY_OVERHEAD_BYTES = 1024;
/** Deflate level of the JSON entries (audio is stored as is). */
const JSON_DEFLATE_LEVEL = 6;

/**
 * A zip being written a piece at a time: finished bytes go to `write` in order, the first failure is kept and
 * thrown by `flushed()`, so a slow or failing destination never reorders or loses bytes.
 */
class ZipOutput {
  private readonly zip: Zip;
  private chain: Promise<void> = Promise.resolve();
  private error: unknown = null;
  private readonly ended: Promise<void>;
  /** Bytes the zip has produced so far. */
  produced = 0;

  constructor(
    write: (bytes: Uint8Array) => Promise<void>,
    private readonly modifiedAt: Date,
  ) {
    let resolveEnd!: () => void;
    this.ended = new Promise<void>((resolve) => (resolveEnd = resolve));
    this.zip = new Zip((err, chunk, isFinal) => {
      if (err) this.error ??= err;
      if (chunk.byteLength > 0) {
        this.produced += chunk.byteLength;
        const copy = chunk.slice();
        this.chain = this.chain
          .then(() => write(copy))
          .catch((e: unknown) => {
            this.error ??= e;
          });
      }
      if (isFinal) void this.chain.then(resolveEnd);
    });
  }

  /** Waits for every produced piece to be written; throws the first failure. */
  async flushed(): Promise<void> {
    await this.chain;
    if (this.error) throw this.error;
  }

  /** Adds a JSON entry (compressed). */
  addJson(name: string, value: unknown, indent?: number): void {
    const file = new ZipDeflate(name, { level: JSON_DEFLATE_LEVEL });
    file.mtime = this.modifiedAt;
    this.zip.add(file);
    file.push(strToU8(JSON.stringify(value ?? null, null, indent)), true);
  }

  /** Adds a stored (uncompressed) entry and feeds it in pieces, waiting for the destination between pieces. */
  async addStored(name: string, bytes: Uint8Array): Promise<void> {
    const file = new ZipPassThrough(name);
    file.mtime = this.modifiedAt;
    this.zip.add(file);
    if (bytes.length === 0) file.push(bytes, true);
    for (let at = 0; at < bytes.length; at += SAMPLE_PIECE_BYTES) {
      const isLastPiece = at + SAMPLE_PIECE_BYTES >= bytes.length;
      file.push(bytes.subarray(at, Math.min(bytes.length, at + SAMPLE_PIECE_BYTES)), isLastPiece);
      await this.flushed();
    }
  }

  /** Ends the zip (writes the directory) and waits for everything to be written. */
  async finish(): Promise<void> {
    this.zip.end();
    await this.ended;
    await this.flushed();
  }
}

/** The limit in words: "4 GB" for the real limit, megabytes for the small ones tests use. */
function describeSizeLimit(maxBytes: number): string {
  return maxBytes >= 2 ** 29
    ? `${Math.round(maxBytes / 2 ** 30)} GB`
    : `${Math.max(1, Math.round(maxBytes / 2 ** 20))} MB`;
}

/**
 * Writes the zip a piece at a time (big projects): the JSON entries, then each sample, read only
 * when it is written and passed on in 1 MB pieces, so memory holds one sample at most. Readers of
 * writeProjectFile's files read these too. Returns the hashes whose bytes were missing (left out).
 */
export async function writeProjectFileStream(
  input: Omit<WriteProjectFileInput, 'samples'> & {
    samples: readonly SampleSource[];
    /** Most bytes the file may reach (default: ZIP_MAX_BYTES; tests lower it). */
    maxBytes?: number;
  },
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<{ missing: string[] }> {
  const maxBytes = input.maxBytes ?? ZIP_MAX_BYTES;
  const meta: ProjectFileMeta = {
    format: PROJECT_FILE_FORMAT,
    appVersion: input.appVersion,
    savedAt: (input.now ?? new Date()).toISOString(),
  };
  const output = new ZipOutput(write, zipTime(input.now ?? new Date()));
  output.addJson('meta.json', meta, 2);
  output.addJson('project.json', input.project);
  output.addJson('view.json', input.view);
  await output.flushed();

  const missing: string[] = [];
  const seen = new Set<string>();
  const samplesByHash = [...input.samples].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (const sample of samplesByHash) {
    if (seen.has(sample.hash)) continue;
    seen.add(sample.hash);
    if (!isSha256Hex(sample.hash)) throw new TypeError(`writeProjectFile: "${sample.hash}" is not a SHA-256 hex hash.`);
    const got = await sample.read();
    if (!got) {
      missing.push(sample.hash);
      continue;
    }
    const ext = normalizeSampleExt(got.ext ?? sample.ext);
    if (!ext) throw new TypeError(`writeProjectFile: "${got.ext ?? sample.ext}" is not a valid sample extension.`);
    // Room for this sample, its headers and the directory that ends the file.
    if (output.produced + got.bytes.length + ENTRY_OVERHEAD_BYTES * (seen.size + 1) > maxBytes) {
      throw new Error(
        `This project is too big to save as one file (the limit is ${describeSizeLimit(maxBytes)}): remove some songs or samples, then save again.`,
      );
    }
    // Audio is already compressed or doesn't deflate well: stored as is.
    await output.addStored(`samples/${sample.hash}.${ext}`, got.bytes);
  }
  for (const [id, bytes] of pluginEntries(input.plugins)) await output.addStored(`plugins/${id}.agplugin`, bytes);
  await output.finish();
  return { missing };
}

/** meta.json, project.json and view.json into the document (shared by both readers). */
function interpretEntries(
  metaBytes: Uint8Array | undefined,
  projectBytes: Uint8Array | undefined,
  viewBytes: Uint8Array | undefined,
  opts: { migrations?: readonly (Migration | undefined)[] },
): Omit<ProjectFileContents, 'samples' | 'plugins'> {
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
