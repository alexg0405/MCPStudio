/**
 * Where the sample browser keeps what it learns: the analysis of each folder (`sample-analysis:<folder key>`, one record per
 * folder, see `core/samples/cache.ts`), your favorites, tags and recently used sounds (`sample-user:v1`) and the view
 * settings (`sample-view:v1`), all in the IndexedDB key-value store. None of them holds a content hash, so none of them keeps
 * audio alive for the storage clean-up (docs/architecture.md, "Clean-up of unused audio").
 */
import type { FolderRecord } from '@core/samples/cache';
import { idbDel, idbGet, idbSet, isIdbAvailable } from '@platform/idb';

/** What you added to files: favorites, your own tags, when each sound was last used. Keys are row ids (`<folder key>:<path>`). */
export interface UserData {
  favorites: string[];
  tags: Record<string, string[]>;
  lastUsed: Record<string, number>;
}

export const emptyUser = (): UserData => ({ favorites: [], tags: {}, lastUsed: {} });

/** The most recently used sounds kept (the list is for "recent", not a history). */
export const MAX_RECENT = 300;

/** A user record read back from storage, damaged parts dropped. */
export function readUser(raw: unknown): UserData {
  const r = raw as Partial<UserData> | null;
  const out = emptyUser();
  if (!r || typeof r !== 'object') return out;
  if (Array.isArray(r.favorites)) out.favorites = r.favorites.filter((x): x is string => typeof x === 'string');
  if (r.tags && typeof r.tags === 'object')
    for (const [k, v] of Object.entries(r.tags)) if (Array.isArray(v)) out.tags[k] = v.filter((t): t is string => typeof t === 'string');
  if (r.lastUsed && typeof r.lastUsed === 'object')
    for (const [k, v] of Object.entries(r.lastUsed)) if (typeof v === 'number' && Number.isFinite(v)) out.lastUsed[k] = v;
  return out;
}

/** View settings that outlive the session. */
export interface ViewPrefs {
  volume: number;
  syncTempo: boolean;
  syncMode: 'stretch' | 'resample';
  inKey: boolean;
  autoPreview: boolean;
  sort: string;
  descending: boolean;
}

export interface SampleBrowserStorage {
  loadRecord(folderKey: string): Promise<unknown>;
  saveRecord(folderKey: string, record: FolderRecord): Promise<void>;
  deleteRecord(folderKey: string): Promise<void>;
  loadUser(): Promise<UserData>;
  saveUser(user: UserData): Promise<void>;
  loadPrefs(): Promise<Partial<ViewPrefs> | null>;
  savePrefs(prefs: ViewPrefs): Promise<void>;
}

const recordKey = (folderKey: string) => `sample-analysis:${folderKey}`;
const USER_KEY = 'sample-user:v1';
const PREFS_KEY = 'sample-view:v1';

export const idbBrowserStorage: SampleBrowserStorage = {
  async loadRecord(folderKey) {
    return isIdbAvailable() ? idbGet(recordKey(folderKey)) : undefined;
  },
  async saveRecord(folderKey, record) {
    if (isIdbAvailable()) await idbSet(recordKey(folderKey), record);
  },
  async deleteRecord(folderKey) {
    if (isIdbAvailable()) await idbDel(recordKey(folderKey));
  },
  async loadUser() {
    return isIdbAvailable() ? readUser(await idbGet(USER_KEY)) : emptyUser();
  },
  async saveUser(user) {
    if (isIdbAvailable()) await idbSet(USER_KEY, user);
  },
  async loadPrefs() {
    return isIdbAvailable() ? ((await idbGet<Partial<ViewPrefs>>(PREFS_KEY)) ?? null) : null;
  },
  async savePrefs(prefs) {
    if (isIdbAvailable()) await idbSet(PREFS_KEY, prefs);
  },
};

/** Kept in memory (tests): what was saved can be looked at. */
export function memoryBrowserStorage(): SampleBrowserStorage & { records: Map<string, FolderRecord>; user: UserData; prefs: ViewPrefs | null; saves: number } {
  const self = {
    records: new Map<string, FolderRecord>(),
    user: emptyUser(),
    prefs: null as ViewPrefs | null,
    saves: 0,
    loadRecord: (key: string) => Promise.resolve(self.records.get(key) ? structuredClone(self.records.get(key)) : undefined),
    saveRecord: (key: string, record: FolderRecord) => {
      self.saves++;
      self.records.set(key, structuredClone(record));
      return Promise.resolve();
    },
    deleteRecord: (key: string) => {
      self.records.delete(key);
      return Promise.resolve();
    },
    loadUser: () => Promise.resolve(structuredClone(self.user)),
    saveUser: (user: UserData) => {
      self.user = structuredClone(user);
      return Promise.resolve();
    },
    loadPrefs: () => Promise.resolve(self.prefs ? structuredClone(self.prefs) : null),
    savePrefs: (prefs: ViewPrefs) => {
      self.prefs = structuredClone(prefs);
      return Promise.resolve();
    },
  };
  return self;
}
