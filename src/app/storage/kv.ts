import { idbDelMany, idbEntries, idbGetMany, idbKeys, idbRaiseMany, idbSetMany, isIdbAvailable } from '@platform/idb';

/**
 * The small key-value store the clean-up of unused audio keeps its records in (the app's IndexedDB `kv`
 * store, shared by every tab of this browser profile). Keys under `gc:` are ours:
 *
 *   gc:tab:<session id>   what an open tab uses (`TabRecord`)
 *   gc:seen:<hash>        when a blob was last written or seen in use (ms)
 *   gc:last-run           how the last clean-up went (`GcLastRun`)
 */
export interface GcKv {
  /** Entries whose key passes `keep`. */
  entries(keep: (key: string) => boolean): Promise<Array<[string, unknown]>>;
  /** Values by key (missing keys are left out). */
  getMany(keys: readonly string[]): Promise<Map<string, unknown>>;
  /** Keys that pass `keep`. */
  keys(keep: (key: string) => boolean): Promise<string[]>;
  set(entries: ReadonlyArray<readonly [string, unknown]>): Promise<void>;
  /** Stores each number unless the key already holds a larger one (atomically: a "seen" mark never goes back in time). */
  raise(entries: ReadonlyArray<readonly [string, number]>): Promise<void>;
  del(keys: readonly string[]): Promise<void>;
}

export const TAB_PREFIX = 'gc:tab:';
export const SEEN_PREFIX = 'gc:seen:';
export const LAST_RUN_KEY = 'gc:last-run';
/** Cached track analyses are keyed by content hash but are not "use" of the audio (see analysis-cache.ts). */
export const ANALYSIS_PREFIX = 'dj-analysis:';
/** Cached pitch analyses of clips (app/pitch/analysis-store.ts): keyed by sample hash (last segment), not a use either. */
export const PITCH_ANALYSIS_PREFIX = 'pitch-analysis:';
/** True for keys of cached analyses: derived data that names a hash without using the audio. */
export const isAnalysisKey = (key: string): boolean => key.startsWith(ANALYSIS_PREFIX) || key.startsWith(PITCH_ANALYSIS_PREFIX);
/** The DJ library's saved songs (app/dj/library.ts). */
export const DJ_LIBRARY_KEY = 'dj-library';

export const tabKey = (id: string) => `${TAB_PREFIX}${id}`;
export const seenKey = (hash: string) => `${SEEN_PREFIX}${hash}`;

export interface GcLastRun {
  /** Date.now() when it finished. */
  at: number;
  /** Blobs removed (or that a dry run would have removed). */
  removed: number;
  bytes: number;
  dryRun: boolean;
}

/** The app's IndexedDB. */
export const idbKv: GcKv = {
  entries: (keep) => idbEntries(keep),
  async getMany(keys) {
    return idbGetMany(keys);
  },
  async keys(keep) {
    return (await idbKeys()).filter((k): k is string => typeof k === 'string' && keep(k));
  },
  set: (entries) => idbSetMany(entries),
  raise: (entries) => idbRaiseMany(entries),
  del: (keys) => idbDelMany(keys),
};

export const isKvAvailable = isIdbAvailable;

/** An in-memory store (tests). Shared between "tabs" of a test by passing the same instance. */
export function memoryKv(initial: Record<string, unknown> = {}): GcKv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    async entries(keep) {
      return [...data].filter(([k]) => keep(k)).map(([k, v]) => [k, structuredClone(v)] as [string, unknown]);
    },
    async getMany(keys) {
      const out = new Map<string, unknown>();
      for (const k of keys) if (data.has(k)) out.set(k, structuredClone(data.get(k)));
      return out;
    },
    async keys(keep) {
      return [...data.keys()].filter(keep);
    },
    async set(entries) {
      for (const [k, v] of entries) data.set(k, structuredClone(v));
    },
    async raise(entries) {
      for (const [k, v] of entries) {
        const cur = data.get(k);
        if (typeof cur !== 'number' || cur < v) data.set(k, v);
      }
    },
    async del(keys) {
      for (const k of keys) data.delete(k);
    },
  };
}
