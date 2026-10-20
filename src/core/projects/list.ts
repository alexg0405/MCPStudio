/**
 * The list of your projects, put together from what the app already remembers: the files it has opened or saved, the
 * autosaves of work in progress and the projects that have versions. Pure: the app reads those sources and hands them
 * here, and the same list comes out for the same input, so ordering and search are plain tests.
 */
import type { ProjectFacts } from '../versions/facts';
import type { Thumbnail } from '../versions/thumbnail';

/** What the app keeps about a project it has seen: the numbers a card shows, so listing needs no file to be opened. */
export interface ProjectCard {
  /** Layout of this record. */
  v: 1;
  projectId: string;
  /** The name shown: the file's name without `.agproj`, or "Untitled". */
  name: string;
  /** Key of the remembered file handle (`persistence/recent-files`), when the project lives in a file. */
  fileKey?: string;
  /** When it was last opened, saved or made (ms since 1970). */
  lastOpenedAt: number;
  /** When its content last changed (ms since 1970). */
  lastModifiedAt: number;
  facts: ProjectFacts;
  /** The arrangement picture, drawn from the playlist when the card was written. */
  thumbnail: Thumbnail | null;
  pinned: boolean;
  /** The musician removed it from the list (its file and versions are untouched). */
  removed: boolean;
}

/** The start of the key a project card is stored under in the app's IndexedDB `kv` store. */
export const CARD_KEY_PREFIX = 'project-card:';

/** The kv key of a project's card. */
export const cardKey = (projectId: string): string => `${CARD_KEY_PREFIX}${projectId}`;

/** True when the value has the shape of a stored card. */
export function isProjectCard(value: unknown): value is ProjectCard {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<ProjectCard>;
  return (
    c.v === 1 &&
    typeof c.projectId === 'string' &&
    typeof c.name === 'string' &&
    typeof c.lastOpenedAt === 'number' &&
    typeof c.lastModifiedAt === 'number' &&
    typeof c.facts === 'object' &&
    c.facts !== null &&
    typeof c.pinned === 'boolean' &&
    typeof c.removed === 'boolean'
  );
}

/** A remembered file, as `recent-files` keeps it. */
export interface RecentFileInfo {
  key: string;
  /** File name including `.agproj`. */
  name: string;
  /** ISO 8601. */
  usedAt: string;
}

/** An autosave's meta, as the autosave store lists it. */
export interface AutosaveInfo {
  sessionId: string;
  projectId: string;
  title: string;
  /** ISO 8601. */
  savedAt: string;
  /** The session ended with nothing unsaved. */
  clean: boolean;
  fileKey?: string;
}

/** The newest version of a project, and how many it has. */
export interface VersionSummary {
  count: number;
  newestAt: number;
  title: string;
}

/** Where a listed project is opened from. */
export type ProjectSource = 'file' | 'autosave' | 'versions';

/** One row of the project list. */
export interface ListedProject {
  /** Stable key: the project's id, or `file:<key>` for a remembered file with no card yet. */
  id: string;
  name: string;
  source: ProjectSource;
  /** Present for `file`: the remembered handle's key. */
  fileKey?: string;
  /** Present when the project's identity is known. */
  projectId?: string;
  /** Present for `autosave`. */
  sessionId?: string;
  lastOpenedAt: number;
  lastModifiedAt: number;
  facts: ProjectFacts | null;
  thumbnail: Thumbnail | null;
  pinned: boolean;
  versionCount: number;
  /** An autosave holds changes that are not in the file yet. */
  hasUnsavedWork: boolean;
  /** It is the project that is open now. */
  isOpen: boolean;
}

/** Everything the list is made from. */
export interface ProjectListInput {
  cards: readonly ProjectCard[];
  recents: readonly RecentFileInfo[];
  autosaves: readonly AutosaveInfo[];
  versions: ReadonlyMap<string, VersionSummary>;
  /** The open project's id. */
  openProjectId?: string;
}

const timeOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** The name of a file without its extension ("Night Drive.agproj" → "Night Drive"). */
export const plainFileName = (fileName: string): string => fileName.replace(/\.agproj$/i, '').trim() || 'Untitled';

/** How a card with no file to open is opened: its unsaved autosave, else its latest version, else not at all. */
function sourceOfCard(hasFile: boolean, autosave: AutosaveInfo | undefined, hasVersions: boolean): ProjectSource | null {
  if (hasFile) return 'file';
  if (autosave) return 'autosave';
  return hasVersions ? 'versions' : null;
}

function listCard(card: ProjectCard, input: ProjectListInput, recentByKey: Map<string, RecentFileInfo>): ListedProject | null {
  const recent = card.fileKey ? recentByKey.get(card.fileKey) : undefined;
  const autosave = newestAutosave(input.autosaves, card.projectId);
  const versions = input.versions.get(card.projectId);
  const source = sourceOfCard(!!recent, autosave, !!versions);
  if (!source) return null;
  const autosavedAt = autosave ? timeOf(autosave.savedAt) : 0;
  return {
    id: card.projectId,
    name: recent ? plainFileName(recent.name) : card.name,
    source,
    ...(recent ? { fileKey: recent.key } : {}),
    projectId: card.projectId,
    ...(source === 'autosave' && autosave ? { sessionId: autosave.sessionId } : {}),
    lastOpenedAt: Math.max(card.lastOpenedAt, recent ? timeOf(recent.usedAt) : 0),
    lastModifiedAt: card.lastModifiedAt,
    facts: card.facts,
    thumbnail: card.thumbnail,
    pinned: card.pinned,
    versionCount: versions?.count ?? 0,
    hasUnsavedWork: !!autosave && !autosave.clean && autosavedAt > card.lastModifiedAt,
    isOpen: input.openProjectId === card.projectId,
  };
}

function newestAutosave(autosaves: readonly AutosaveInfo[], projectId: string): AutosaveInfo | undefined {
  let newest: AutosaveInfo | undefined;
  for (const meta of autosaves) {
    if (meta.projectId !== projectId) continue;
    if (!newest || timeOf(meta.savedAt) > timeOf(newest.savedAt)) newest = meta;
  }
  return newest;
}

/** A remembered file no card describes yet (opened by an older version of the app): listed by name. */
function listBareFile(recent: RecentFileInfo): ListedProject {
  const usedAt = timeOf(recent.usedAt);
  return {
    id: `file:${recent.key}`,
    name: plainFileName(recent.name),
    source: 'file',
    fileKey: recent.key,
    lastOpenedAt: usedAt,
    lastModifiedAt: usedAt,
    facts: null,
    thumbnail: null,
    pinned: false,
    versionCount: 0,
    hasUnsavedWork: false,
    isOpen: false,
  };
}

/** An autosave whose project no card or file explains: unsaved work, listed so it can be found and opened. */
function listBareAutosave(meta: AutosaveInfo, input: ProjectListInput): ListedProject {
  const savedAt = timeOf(meta.savedAt);
  return {
    id: meta.projectId,
    name: meta.title || 'Untitled',
    source: 'autosave',
    projectId: meta.projectId,
    sessionId: meta.sessionId,
    lastOpenedAt: savedAt,
    lastModifiedAt: savedAt,
    facts: null,
    thumbnail: null,
    pinned: false,
    versionCount: input.versions.get(meta.projectId)?.count ?? 0,
    hasUnsavedWork: !meta.clean,
    isOpen: input.openProjectId === meta.projectId,
  };
}

/** A project that only has versions (no card, file or autosave): opened from its newest version. */
function listBareVersions(projectId: string, summary: VersionSummary, input: ProjectListInput): ListedProject {
  return {
    id: projectId,
    name: summary.title || 'Untitled',
    source: 'versions',
    projectId,
    lastOpenedAt: summary.newestAt,
    lastModifiedAt: summary.newestAt,
    facts: null,
    thumbnail: null,
    pinned: false,
    versionCount: summary.count,
    hasUnsavedWork: false,
    isOpen: input.openProjectId === projectId,
  };
}

/** The projects to list, unsorted: one row per project, however many places remember it. */
export function mergeProjectList(input: ProjectListInput): ListedProject[] {
  const recentByKey = new Map(input.recents.map((recent) => [recent.key, recent] as const));
  const listed: ListedProject[] = [];
  const seenProjects = new Set<string>();
  const seenFiles = new Set<string>();
  const removed = new Set<string>();
  for (const card of input.cards) {
    if (card.removed) {
      removed.add(card.projectId);
      if (card.fileKey) seenFiles.add(card.fileKey);
      continue;
    }
    const row = listCard(card, input, recentByKey);
    if (!row) continue;
    seenProjects.add(card.projectId);
    if (row.fileKey) seenFiles.add(row.fileKey);
    listed.push(row);
  }
  for (const recent of input.recents) {
    if (!seenFiles.has(recent.key)) listed.push(listBareFile(recent));
  }
  for (const meta of input.autosaves) {
    if (seenProjects.has(meta.projectId) || removed.has(meta.projectId)) continue;
    // A clean autosave of a project in a remembered file says nothing the file does not.
    if (meta.clean || (meta.fileKey && recentByKey.has(meta.fileKey))) continue;
    seenProjects.add(meta.projectId);
    listed.push(listBareAutosave(meta, input));
  }
  for (const [projectId, summary] of input.versions) {
    if (seenProjects.has(projectId) || removed.has(projectId)) continue;
    listed.push(listBareVersions(projectId, summary, input));
  }
  return listed;
}

/** How the list is ordered (pinned projects always come first). */
export type ProjectSort = 'recent' | 'modified' | 'name' | 'length' | 'tempo';

export const PROJECT_SORTS: ReadonlyArray<{ id: ProjectSort; label: string }> = [
  { id: 'recent', label: 'Last opened' },
  { id: 'modified', label: 'Last changed' },
  { id: 'name', label: 'Name' },
  { id: 'length', label: 'Length' },
  { id: 'tempo', label: 'Tempo' },
];

function compareBy(sort: ProjectSort, a: ListedProject, b: ListedProject): number {
  switch (sort) {
    case 'recent':
      return b.lastOpenedAt - a.lastOpenedAt;
    case 'modified':
      return b.lastModifiedAt - a.lastModifiedAt;
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    case 'length':
      return (b.facts?.lengthSec ?? 0) - (a.facts?.lengthSec ?? 0);
    case 'tempo':
      return (a.facts?.bpm ?? Infinity) - (b.facts?.bpm ?? Infinity);
  }
}

/** The list in order: pinned first, then by `sort`, ties by name and then id so the order never jumps. */
export function sortProjects(items: readonly ListedProject[], sort: ProjectSort): ListedProject[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byKey = compareBy(sort, a, b);
    if (byKey !== 0) return byKey;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return byName !== 0 ? byName : a.id < b.id ? -1 : 1;
  });
}

/** The words a search looks in: name, key, tempo, and where the project is kept. */
function searchText(item: ListedProject): string {
  const facts = item.facts;
  const parts = [item.name, facts?.key ?? '', facts ? `${facts.bpm} bpm` : '', item.hasUnsavedWork ? 'unsaved' : ''];
  return parts.join(' ').toLowerCase();
}

/** Projects that match every word of the query (case and order do not matter); an empty query matches all. */
export function filterProjects(items: readonly ListedProject[], query: string): ListedProject[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const text = searchText(item);
    return words.every((word) => text.includes(word));
  });
}
