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
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { SCHEMA_VERSION, type Project } from '../model/types';
import { MIGRATIONS, SchemaError, migrateProject, repairProject, type Migration } from '../schema/migrate';
import { isSha256Hex } from './hash';

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

  const repairs: string[] = [];
  const meta = readMeta(entries['meta.json'], repairs);

  const projectBytes = entries['project.json'];
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
  const viewBytes = entries['view.json'];
  if (viewBytes) {
    try {
      view = parseJson(viewBytes);
    } catch {
      repairs.push("The saved window layout couldn't be read and was reset.");
    }
  }

  const samples = new Map<string, EmbeddedSample>();
  for (const [name, data] of Object.entries(entries)) {
    const m = SAMPLE_ENTRY.exec(name);
    if (!m) continue;
    const hash = (m[1] as string).toLowerCase();
    if (!samples.has(hash)) samples.set(hash, { ext: (m[2] as string).toLowerCase(), bytes: data });
  }
  return { project: repaired.project, view, meta, samples, repairs, migratedFrom: migrated.migratedFrom };
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
