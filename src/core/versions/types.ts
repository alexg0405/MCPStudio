/**
 * Versions: save points of a project that stay in this browser, so no change is ever lost for good. A version is the whole
 * project (and its window layout) at one moment. Its audio is not copied: the samples stay in the sample store, shared
 * by hash with the open project and every other version, and a version only remembers which hashes it needs.
 */
import type { ProjectFacts } from './facts';

/** Why a version was made. The first three are the app's regular save points. */
export type SavePointReason =
  /** The musician saved the project to its file. */
  | 'save'
  /** A few minutes of editing since the last version. */
  | 'timer'
  /** The tab was closing with changes since the last version. */
  | 'close'
  /** Just before a big change: an AI answer, the arranger, "clean up the song", a conversion, a very large edit. */
  | 'before-ai'
  | 'before-arrange'
  | 'before-tidy'
  | 'before-convert'
  | 'before-big'
  /** Just before a version replaced the song, so a restore can itself be undone for good. */
  | 'before-restore'
  /** The musician asked for it ("Save a version"). */
  | 'named';

/** What the app keeps about one version (in IndexedDB; its project is a compressed file in OPFS). */
export interface VersionRecord {
  /** Layout of this record. */
  v: 1;
  /** `ver_` and ten random characters. */
  id: string;
  /** The project it belongs to (`Project.projectId`: stays the same across saves, renames and Save as). */
  projectId: string;
  /** When it was made (ms since 1970). */
  createdAt: number;
  reason: SavePointReason;
  /** The musician's name for it ("Before vocals"). Absent for automatic save points. */
  name?: string;
  /** What the app was about to do ("add a bass line"), for an automatic save point. */
  note?: string;
  /** Kept forever: retention never removes it. A named version is pinned when it is made. */
  pinned: boolean;
  /** Bytes of the stored file. */
  size: number;
  /** SHA-256 of the project as it was serialized: two versions with the same value hold the same song. */
  contentHash: string;
  /** Every sample hash the version needs (storage clean-up keeps these samples while the version exists). */
  hashes: string[];
  /** The project's title when it was made. */
  title: string;
  /** Length, tempo and size of the song then. */
  facts: ProjectFacts;
  /** What changed since the version before it: short phrases ("+3 clips", "mixer: Kick −2.0 dB"). */
  changes: string[];
  /** The same as one line. */
  summary: string;
}

/** The start of the key a version record is stored under in the app's IndexedDB `kv` store. */
export const VERSION_KEY_PREFIX = 'version:';

/** The kv key of a version. */
export const versionKey = (projectId: string, id: string): string => `${VERSION_KEY_PREFIX}${projectId}:${id}`;

/** True for the kv key of a version record. */
export const isVersionKey = (key: string): boolean => key.startsWith(VERSION_KEY_PREFIX);

const REASON_WORDS: Readonly<Record<SavePointReason, string>> = {
  save: 'Saved',
  timer: 'Automatic save point',
  close: 'When the tab closed',
  'before-ai': 'Before a Studio answer',
  'before-arrange': 'Before arranging',
  'before-tidy': 'Before cleaning up',
  'before-convert': 'Before converting',
  'before-big': 'Before a big change',
  'before-restore': 'Before restoring a version',
  named: 'Saved by you',
};

/** A plain label for a version: its name, else the reason it was made ("Before a Studio answer: add a bass"). */
export function versionTitle(record: Pick<VersionRecord, 'name' | 'note' | 'reason'>): string {
  if (record.name) return record.name;
  const words = REASON_WORDS[record.reason];
  return record.note ? `${words}: ${record.note}` : words;
}

/** True when the value has the shape of a stored record (a damaged or foreign value is ignored, never trusted). */
export function isVersionRecord(value: unknown): value is VersionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<VersionRecord>;
  return (
    r.v === 1 &&
    typeof r.id === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.createdAt === 'number' &&
    Number.isFinite(r.createdAt) &&
    typeof r.reason === 'string' &&
    r.reason in REASON_WORDS &&
    typeof r.pinned === 'boolean' &&
    typeof r.size === 'number' &&
    typeof r.contentHash === 'string' &&
    Array.isArray(r.hashes) &&
    typeof r.title === 'string' &&
    typeof r.facts === 'object' &&
    r.facts !== null &&
    Array.isArray(r.changes) &&
    typeof r.summary === 'string'
  );
}
