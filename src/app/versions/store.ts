import type { PluginInfoResolver } from '@core/automation/labels';
import { collectHashes } from '@core/gc/refs';
import { sha256Hex } from '@core/io/hash';
import { projectFileParts, readProjectFile, zipProjectFileParts, type ProjectFileParts } from '@core/io/project-file';
import { randomId } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { describeProjectChanges, summarizeChanges } from '@core/versions/diff';
import { projectFacts } from '@core/versions/facts';
import { planRetention, DEFAULT_RETENTION, type RetentionPolicy } from '@core/versions/retention';
import {
  isVersionKey,
  isVersionRecord,
  versionKey,
  VERSION_KEY_PREFIX,
  type SavePointReason,
  type VersionRecord,
} from '@core/versions/types';
import type { VersionFileStore } from '@platform/opfs';
import { strToU8 } from 'fflate';
import type { GcKv } from '../storage/kv';

/**
 * Where versions live. A version is two things that are written in this order: a compressed thin project file in OPFS
 * (`VersionFileStore`) and a small record in the app's IndexedDB `kv` store. The record is what the storage clean-up
 * reads: it holds every sample hash the version needs, so a sample only an old version uses is kept until that version
 * is deleted (and then waits out the usual one-week grace). Removal goes in the opposite order, file then record, so a
 * crash leaves either an orphan file (adopted again by `reconcile`) or a record with no file (dropped by it), never a
 * version that looks fine and cannot be opened.
 */

/** What is needed to make a version. */
export interface NewVersion {
  project: Project;
  /** The window layout to keep with it (anything JSON can hold). */
  view: unknown;
  reason: SavePointReason;
  /** The musician's name for it; a named version is pinned. */
  name?: string;
  /** What the app was about to do, for an automatic save point. */
  note?: string;
  pinned?: boolean;
  /** The project as it was at the version before this one, when the caller has it (saves reading it back). */
  previous?: Project;
  /** Compress on this thread (the page is closing, a Worker may never answer). */
  urgent?: boolean;
}

export interface VersionStoreDeps {
  kv: GcKv;
  files: VersionFileStore;
  appVersion: string;
  /** Compresses a project file's parts (default: on this thread). */
  zip?(parts: ProjectFileParts): Promise<Uint8Array>;
  now?(): number;
  pluginInfo?: PluginInfoResolver;
}

/** A version that cannot be read back: its file is gone or damaged. */
export class VersionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VersionError';
  }
}

/** A version read back: the project as saved (migrated and repaired like any opened file) and its layout. */
export interface LoadedVersion {
  project: Project;
  view: unknown;
}

/** The numbers Versions → storage shows. */
export interface VersionUsage {
  count: number;
  bytes: number;
}

/** The bytes of `project.json` inside the parts (what the content hash is taken of). */
function projectJsonBytes(parts: ProjectFileParts): Uint8Array {
  const entry = parts.files['project.json'];
  const bytes = Array.isArray(entry) ? entry[0] : entry;
  return bytes as Uint8Array;
}

const newestFirst = (a: VersionRecord, b: VersionRecord) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/** Reads and writes versions. Knows nothing of when to make one (that is `VersionService`). */
export class VersionStore {
  constructor(private readonly deps: VersionStoreDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A project's versions, newest first. Records that are not versions (damaged or foreign) are ignored. */
  async list(projectId: string): Promise<VersionRecord[]> {
    const prefix = `${VERSION_KEY_PREFIX}${projectId}:`;
    const entries = await this.deps.kv.entries((key) => key.startsWith(prefix));
    return entries.map(([, value]) => value).filter(isVersionRecord).sort(newestFirst);
  }

  /** Every project's versions, newest first within each project. */
  async listAll(): Promise<Map<string, VersionRecord[]>> {
    const entries = await this.deps.kv.entries(isVersionKey);
    const byProject = new Map<string, VersionRecord[]>();
    for (const [, value] of entries) {
      if (!isVersionRecord(value)) continue;
      const list = byProject.get(value.projectId) ?? [];
      list.push(value);
      byProject.set(value.projectId, list);
    }
    for (const list of byProject.values()) list.sort(newestFirst);
    return byProject;
  }

  /** One version's record, or null. */
  async get(projectId: string, id: string): Promise<VersionRecord | null> {
    const found = (await this.deps.kv.getMany([versionKey(projectId, id)])).get(versionKey(projectId, id));
    return isVersionRecord(found) ? found : null;
  }

  /**
   * Saves a version. Returns null when nothing changed since the newest version (the same song again is not a new
   * version), except that a name asked for is put on that newest version instead, so "Save a version" always ends with a
   * named, pinned version.
   */
  async create(input: NewVersion): Promise<VersionRecord | null> {
    const { project, view } = input;
    const createdAt = this.now();
    const parts = projectFileParts({
      project,
      view,
      samples: new Map(),
      appVersion: this.deps.appVersion,
      now: new Date(createdAt),
    });
    const contentHash = await sha256Hex(projectJsonBytes(parts));
    const existing = await this.list(project.projectId);
    const latest = existing[0];
    if (latest && latest.contentHash === contentHash) return input.name ? this.nameExisting(latest, input) : null;

    const bytes = input.urgent || !this.deps.zip ? zipProjectFileParts(parts) : await this.deps.zip(parts);
    const id = randomId('ver');
    await this.deps.files.write(project.projectId, id, bytes);
    const changes = await this.changesSince(latest ?? null, project, input.previous);
    const record: VersionRecord = {
      v: 1,
      id,
      projectId: project.projectId,
      createdAt,
      reason: input.reason,
      ...(input.name ? { name: input.name } : {}),
      ...(input.note ? { note: input.note } : {}),
      pinned: input.pinned === true || !!input.name,
      size: bytes.byteLength,
      contentHash,
      hashes: [...collectHashes([project, view])],
      title: project.meta.title,
      facts: projectFacts(project),
      changes: changes.parts,
      summary: changes.summary,
    };
    await this.deps.kv.set([[versionKey(record.projectId, record.id), record]]);
    return record;
  }

  /** Names and pins the newest version (the song has not changed since it was made). */
  private async nameExisting(latest: VersionRecord, input: NewVersion): Promise<VersionRecord> {
    const named: VersionRecord = { ...latest, name: input.name as string, pinned: true };
    await this.deps.kv.set([[versionKey(latest.projectId, latest.id), named]]);
    return named;
  }

  /** What changed since the version before: from the project in memory when given, else read back from storage. */
  private async changesSince(
    latest: VersionRecord | null,
    project: Project,
    previous: Project | undefined,
  ): Promise<{ parts: string[]; summary: string }> {
    if (!latest) return { parts: ['first version'], summary: 'First version of this project' };
    let before = previous;
    if (!before) {
      try {
        before = (await this.read(latest)).project;
      } catch {
        return { parts: [], summary: 'Changes since the version before are unknown' };
      }
    }
    const { parts } = describeProjectChanges(before, project, this.deps.pluginInfo);
    return { parts, summary: summarizeChanges(parts) };
  }

  /** Reads a version back like an opened file (older formats are migrated, damage repaired). */
  async read(record: Pick<VersionRecord, 'projectId' | 'id'>): Promise<LoadedVersion> {
    const bytes = await this.deps.files.read(record.projectId, record.id);
    if (!bytes) throw new VersionError('This version’s file is missing, so it cannot be opened.');
    try {
      const contents = readProjectFile(bytes);
      return { project: contents.project, view: contents.view };
    } catch (cause) {
      throw new VersionError('This version’s file is damaged and cannot be opened.', { cause });
    }
  }

  /** Renames a version, pins or unpins it. Naming one pins it (a name says the musician cares). */
  async update(record: VersionRecord, change: { name?: string | null; pinned?: boolean }): Promise<VersionRecord> {
    const next: VersionRecord = { ...record };
    if (change.name !== undefined) {
      const name = change.name?.trim() ?? '';
      if (name) {
        next.name = name;
        next.pinned = true;
      } else delete next.name;
    }
    if (change.pinned !== undefined) next.pinned = change.pinned;
    await this.deps.kv.set([[versionKey(next.projectId, next.id), next]]);
    return next;
  }

  /** Deletes a version: its file first, then the record that kept its samples in use. */
  async remove(record: Pick<VersionRecord, 'projectId' | 'id'>): Promise<void> {
    await this.deps.files.remove(record.projectId, record.id);
    await this.deps.kv.del([versionKey(record.projectId, record.id)]);
  }

  /** Deletes every version of a project. */
  async removeProject(projectId: string): Promise<number> {
    const records = await this.list(projectId);
    for (const record of records) await this.remove(record);
    return records.length;
  }

  /**
   * Deletes the versions retention no longer keeps (pinned and the newest stay). Returns the versions it deleted.
   */
  async prune(
    projectId: string,
    policy: RetentionPolicy = DEFAULT_RETENTION,
    utcOffsetMinutes = 0,
  ): Promise<VersionRecord[]> {
    const records = await this.list(projectId);
    const doomed = new Set(planRetention(records, this.now(), policy, utcOffsetMinutes));
    const removed: VersionRecord[] = [];
    for (const record of records) {
      if (!doomed.has(record.id)) continue;
      await this.remove(record);
      removed.push(record);
    }
    return removed;
  }

  /** How many versions and how many bytes: one project's, or every project's. */
  async usage(projectId?: string): Promise<VersionUsage> {
    const lists = projectId ? [await this.list(projectId)] : [...(await this.listAll()).values()];
    let count = 0;
    let bytes = 0;
    for (const list of lists) {
      for (const record of list) {
        count++;
        bytes += record.size;
      }
    }
    return { count, bytes };
  }

  /**
   * Makes the records and the files agree after an interrupted save or delete: a record with no file is dropped, and a
   * file with no record is adopted (read once to rebuild its record), so nothing is orphaned and no version is lost.
   */
  async reconcile(): Promise<{ dropped: number; adopted: number }> {
    const files = await this.deps.files.list();
    const present = new Set(files.map((f) => versionKey(f.projectId, f.versionId)));
    const known = await this.deps.kv.keys(isVersionKey);
    const knownSet = new Set(known);
    const dangling = known.filter((key) => !present.has(key));
    if (dangling.length > 0) await this.deps.kv.del(dangling);
    let adopted = 0;
    for (const file of files) {
      if (knownSet.has(versionKey(file.projectId, file.versionId))) continue;
      if (await this.adopt(file)) adopted++;
    }
    return { dropped: dangling.length, adopted };
  }

  private async adopt(file: { projectId: string; versionId: string; size: number; modifiedAt: number }): Promise<boolean> {
    try {
      const loaded = await this.read({ projectId: file.projectId, id: file.versionId });
      const contentHash = await sha256Hex(strToU8(JSON.stringify(loaded.project)));
      const record: VersionRecord = {
        v: 1,
        id: file.versionId,
        projectId: file.projectId,
        createdAt: file.modifiedAt,
        reason: 'timer',
        pinned: false,
        size: file.size,
        contentHash,
        hashes: [...collectHashes([loaded.project, loaded.view])],
        title: loaded.project.meta.title,
        facts: projectFacts(loaded.project),
        changes: [],
        summary: 'Recovered after an interrupted save',
      };
      await this.deps.kv.set([[versionKey(record.projectId, record.id), record]]);
      return true;
    } catch {
      return false; // unreadable: leave the file for a later look rather than delete what might be work
    }
  }
}
