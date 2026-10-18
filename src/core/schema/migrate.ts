/**
 * Project schema upgrades. This file is the schema's front door: everything outside `core/schema` imports
 * from here.
 *
 * - `migrateProject` checks the version, runs `migrations[n]` (untyped JSON, schema n → n + 1) up to
 *   SCHEMA_VERSION and validates the structure (every container present with the right type).
 * - `repairProject` (in `./repair`, re-exported below) fixes the content: dangling references, order
 *   arrays, out-of-range values. It never throws on a structurally valid project and reports each kind of
 *   fix in plain words.
 *
 * Bumping SCHEMA_VERSION: append a migration here and add a fixture in test/fixtures/projects/.
 */
import { MASTER, SCHEMA_VERSION, type Project } from '../model/types';
import { hasOwn, isObject, type JsonObject } from './json-values';

export { BPM_MAX, BPM_MIN, CHANNEL_VOLUME_MAX, INSERT_VOLUME_MAX, isParamTarget, repairProject } from './repair';

/** A project as parsed from JSON, before it is known to match the current types. */
export type UntypedProject = Record<string, unknown>;
/** Upgrades a schema-n project to schema n + 1 (it may mutate and return its argument). */
export type Migration = (project: UntypedProject) => UntypedProject;

/**
 * v1 → v2: mixer routing (every insert routes to the master, as v1 did implicitly), effect-slot
 * sidechains (none) and MIDI controller links (none). Tolerates damaged data; repair handles it.
 */
const v1ToV2: Migration = (project) => {
  const mixer = project.mixer;
  if (isObject(mixer) && isObject(mixer.inserts)) {
    for (const [id, insert] of Object.entries(mixer.inserts)) {
      if (!isObject(insert)) continue;
      insert.routes = id === MASTER ? [] : [{ to: MASTER, level: 1, pre: false }];
      if (!Array.isArray(insert.fx)) continue;
      for (const slot of insert.fx) {
        if (isObject(slot)) slot.sidechain = null;
      }
    }
  }
  project.controllers = {};
  return project;
};

/**
 * v2 → v3: playlist markers (none). The new audio-clip edits (gain, fades, pitch, reverse, stretch)
 * are optional, so v2 clips are already valid v3 clips.
 */
const v2ToV3: Migration = (project) => {
  if (isObject(project.playlist)) project.playlist.markers = {};
  return project;
};

/** `MIGRATIONS[n]` upgrades schema n to n + 1. Schema 1 is the first version. */
export const MIGRATIONS: readonly (Migration | undefined)[] = [undefined, v1ToV2, v2ToV3];

/** Why a project could not be read: damaged data, a newer schema than this app knows, or no upgrade path. */
export type SchemaErrorCode = 'invalid' | 'too-new' | 'too-old';

/** Thrown by `migrateProject` for data that cannot be turned into a current project. */
export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  /** The schemaVersion found in the data, when known. */
  readonly version?: number;
  constructor(code: SchemaErrorCode, message: string, opts: { version?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SchemaError';
    this.code = code;
    if (opts.version !== undefined) this.version = opts.version;
  }
}

/** The containers every project must have, with the JSON type of each (`path` is the chain of keys). */
const REQUIRED_CONTAINERS: readonly { path: readonly string[]; kind: 'object' | 'array' }[] = [
  { path: ['meta'], kind: 'object' },
  { path: ['transport'], kind: 'object' },
  { path: ['channels'], kind: 'object' },
  { path: ['channelOrder'], kind: 'array' },
  { path: ['patterns'], kind: 'object' },
  { path: ['patternOrder'], kind: 'array' },
  { path: ['playlist'], kind: 'object' },
  { path: ['playlist', 'lanes'], kind: 'object' },
  { path: ['playlist', 'laneOrder'], kind: 'array' },
  { path: ['playlist', 'clips'], kind: 'object' },
  { path: ['playlist', 'markers'], kind: 'object' },
  { path: ['mixer'], kind: 'object' },
  { path: ['mixer', 'inserts'], kind: 'object' },
  { path: ['mixer', 'order'], kind: 'array' },
  { path: ['samples'], kind: 'object' },
];

/**
 * Upgrades parsed project JSON to the current schema and checks its structure. Throws a SchemaError
 * for data that is not a project, comes from a newer version, or has no migration path. The input
 * is never mutated (migrations run on a copy); without migrations the input object is returned.
 */
export function migrateProject(
  json: unknown,
  migrations: readonly (Migration | undefined)[] = MIGRATIONS,
): { project: Project; migratedFrom: number } {
  const migratedFrom = readSchemaVersion(json);
  const upgraded = migratedFrom < SCHEMA_VERSION ? upgrade(json as JsonObject, migratedFrom, migrations) : json;
  checkStructure(upgraded as JsonObject);
  return { project: upgraded as unknown as Project, migratedFrom };
}

/** The `schemaVersion` of project JSON; throws when it is missing, malformed or newer than this app. */
function readSchemaVersion(json: unknown): number {
  if (!isObject(json)) throw new SchemaError('invalid', 'The project data is not an object.');
  const version = json.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new SchemaError('invalid', 'The project data has no valid schemaVersion.');
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaError(
      'too-new',
      `The project uses schema version ${version}; this version of AGstudio reads up to ${SCHEMA_VERSION}.`,
      { version },
    );
  }
  return version;
}

/** Runs the migrations from `fromVersion` up to SCHEMA_VERSION on a copy of the project. */
function upgrade(json: JsonObject, fromVersion: number, migrations: readonly (Migration | undefined)[]): JsonObject {
  let current = JSON.parse(JSON.stringify(json)) as UntypedProject;
  for (let version = fromVersion; version < SCHEMA_VERSION; version++) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new SchemaError('too-old', `There is no upgrade from project schema version ${version}.`, {
        version: fromVersion,
      });
    }
    const next = runMigration(migrate, current, version, fromVersion);
    next.schemaVersion = version + 1;
    current = next;
  }
  return current;
}

/** Runs one migration; a throw or a result that is not an object is reported as invalid data. */
function runMigration(
  migrate: Migration,
  project: UntypedProject,
  version: number,
  fromVersion: number,
): UntypedProject {
  let next: unknown;
  try {
    next = migrate(project);
  } catch (cause) {
    throw new SchemaError('invalid', `Upgrading the project from schema version ${version} failed.`, {
      version: fromVersion,
      cause,
    });
  }
  if (!isObject(next)) {
    throw new SchemaError('invalid', `Upgrading from schema version ${version} produced no project.`, {
      version: fromVersion,
    });
  }
  return next;
}

/** Throws when a required container is missing or has the wrong JSON type. */
function checkStructure(project: JsonObject): void {
  for (const { path, kind } of REQUIRED_CONTAINERS) {
    let node: unknown = project;
    for (const key of path) node = isObject(node) && hasOwn(node, key) ? node[key] : undefined;
    const hasRightType = kind === 'array' ? Array.isArray(node) : isObject(node);
    if (!hasRightType) throw new SchemaError('invalid', `The project data has no valid "${path.join('.')}" ${kind}.`);
  }
}
