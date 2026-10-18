/**
 * The sample browser's model (`services.sampleBrowser`): every audio file of your sample folders as a row with what the
 * analysis found (kind, category, tempo, key, loudness…), your favorites, tags and recently used sounds, and the filter,
 * sort and selection the window shows. Folders come from `persistence/sample-folders`; analyses run in Workers
 * (`runner.ts`), a few at a time, cached per folder in IndexedDB (`storage.ts`) so a folder is analyzed once.
 *
 * Nothing here is in the project: no History, no undo. Placing a sound in the project is `actions.ts`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { prune, readRecord, reconcile, store as cacheStore, type FileIdentity, type FolderRecord } from '@core/samples/cache';
import { browse, cleanTag, NO_FILTER, type SampleFilter, type SampleRow, type SampleSort } from '@core/samples/query';
import type { SampleAnalysis } from '@core/samples/types';
import { sampleFolders } from '../persistence/sample-folders';
import { analysisWorkerCount, workerPoolRunner, type AnalysisRunner } from './runner';
import { emptyUser, idbBrowserStorage, MAX_RECENT, type SampleBrowserStorage, type UserData, type ViewPrefs } from './storage';

/** What the browser needs of a file's handle. */
export interface FileHandleLike {
  getFile(): Promise<File>;
}

export interface BrowserRow extends SampleRow {
  folderKey: string;
  handle: FileHandleLike;
  /** pending: no analysis yet (or a cached one still being checked); ready; failed: not readable as audio. */
  state: 'pending' | 'ready' | 'failed';
}

export interface AnalysisProgress {
  /** Files to analyze in this run, and how many are done (failed ones included). */
  total: number;
  done: number;
  failed: number;
  running: boolean;
  /** Files per second so far in this run. */
  filesPerSec: number;
}

export interface BrowserState {
  rows: BrowserRow[];
  /** The folders have been read at least once. */
  ready: boolean;
  progress: AnalysisProgress;
  filter: SampleFilter;
  sort: SampleSort;
  descending: boolean;
  selected: string[];
  /** The row the keyboard is on (and the last one clicked). */
  cursor: string | null;
  /** The row being auditioned. */
  playing: string | null;
  /** Audition: level (a linear gain), tempo sync for loops and how, the song's key for notes, auto-play on arrow keys. */
  volume: number;
  syncTempo: boolean;
  syncMode: 'stretch' | 'resample';
  inKey: boolean;
  autoPreview: boolean;
}

/** The part of a folder the browser reads. */
export interface FolderLike {
  key: string;
  name: string;
  access: string;
  files: { name: string; path: string; handle: FileHandleLike }[] | null;
}

export interface SampleBrowserOptions {
  storage?: SampleBrowserStorage;
  /** Makes the runner when the first file needs analyzing (default: a pool of Workers). */
  runner?: () => AnalysisRunner;
  folders?: StoreApi<{ folders: readonly FolderLike[] }>;
  now?: () => number;
  /** Files read for their size and time at once while a folder is checked against its cache. */
  identityBatch?: number;
  /** Milliseconds between the flushes of new analyses into the rows. */
  flushMs?: number;
  /** Milliseconds between saves of a folder's cache while it grows. */
  saveMs?: number;
}

const EMPTY_PROGRESS: AnalysisProgress = { total: 0, done: 0, failed: 0, running: false, filesPerSec: 0 };

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

export class SampleBrowser {
  readonly store: StoreApi<BrowserState>;
  private readonly storage: SampleBrowserStorage;
  private readonly makeRunner: () => AnalysisRunner;
  private readonly folders: StoreApi<{ folders: readonly FolderLike[] }>;
  private readonly now: () => number;
  private readonly batch: number;
  private readonly flushMs: number;
  private readonly saveMs: number;
  private runner: AnalysisRunner | null = null;
  private user: UserData = emptyUser();
  private userLoaded: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The files array each folder was last read from (a change means re-reading). */
  private seen = new Map<string, unknown>();
  private records = new Map<string, FolderRecord>();
  private dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, SampleAnalysis | null>();
  private queue: { row: BrowserRow; ident: FileIdentity; file: File; generation: number }[] = [];
  private inFlight = 0;
  private generation = new Map<string, number>();
  private runStart = 0;
  /** Progress as it happens; published with each flush (the window does not need every file). */
  private live = { total: 0, done: 0, failed: 0 };
  private idleWaiters: (() => void)[] = [];
  private ingests = 0;
  private visibleCache: { rows: BrowserRow[]; filter: SampleFilter; sort: SampleSort; descending: boolean; out: BrowserRow[] } | null = null;

  constructor(opts: SampleBrowserOptions = {}) {
    this.storage = opts.storage ?? idbBrowserStorage;
    this.makeRunner = opts.runner ?? (() => workerPoolRunner(analysisWorkerCount()));
    this.folders = opts.folders ?? (sampleFolders as unknown as StoreApi<{ folders: readonly FolderLike[] }>);
    this.now = opts.now ?? (() => Date.now());
    this.batch = opts.identityBatch ?? 48;
    this.flushMs = opts.flushMs ?? 200;
    this.saveMs = opts.saveMs ?? 4000;
    this.store = createStore<BrowserState>(() => ({
      rows: [],
      ready: false,
      progress: EMPTY_PROGRESS,
      filter: NO_FILTER,
      sort: 'name',
      descending: false,
      selected: [],
      cursor: null,
      playing: null,
      volume: 0.8,
      syncTempo: true,
      syncMode: 'stretch',
      inKey: false,
      autoPreview: true,
    }));
  }

  // ---- Lifecycle ----

  /** Starts following the sample folders (idempotent). */
  start(): void {
    if (this.unsubscribe) return;
    void this.loadUserAndPrefs();
    const sync = () => void this.syncFolders();
    this.unsubscribe = this.folders.subscribe(sync);
    sync();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.runner?.dispose();
    this.runner = null;
    this.queue = [];
    this.inFlight = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flushTimer = this.saveTimer = null;
  }

  private loadUserAndPrefs(): Promise<void> {
    this.userLoaded ??= (async () => {
      try {
        this.user = await this.storage.loadUser();
        const prefs = await this.storage.loadPrefs();
        if (prefs) {
          const patch: Partial<BrowserState> = {};
          if (typeof prefs.volume === 'number') patch.volume = Math.min(2, Math.max(0, prefs.volume));
          if (typeof prefs.syncTempo === 'boolean') patch.syncTempo = prefs.syncTempo;
          if (prefs.syncMode === 'stretch' || prefs.syncMode === 'resample') patch.syncMode = prefs.syncMode;
          if (typeof prefs.inKey === 'boolean') patch.inKey = prefs.inKey;
          if (typeof prefs.autoPreview === 'boolean') patch.autoPreview = prefs.autoPreview;
          if (typeof prefs.sort === 'string') patch.sort = prefs.sort as SampleSort;
          if (typeof prefs.descending === 'boolean') patch.descending = prefs.descending;
          this.store.setState(patch);
        }
      } catch {
        /* no saved settings */
      }
      this.applyUser();
    })();
    return this.userLoaded;
  }

  // ---- Folders and analysis ----

  private async syncFolders(): Promise<void> {
    const folders = this.folders.getState().folders;
    const keys = new Set(folders.map((f) => f.key));
    // Folders that are gone: their rows and their cache.
    for (const key of [...this.seen.keys()]) {
      if (keys.has(key)) continue;
      this.seen.delete(key);
      this.records.delete(key);
      this.dirty.delete(key);
      this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
      this.store.setState((s) => ({ rows: s.rows.filter((r) => r.folderKey !== key) }));
      void this.storage.deleteRecord(key).catch(() => {});
    }
    for (const f of folders) {
      if (!f.files || this.seen.get(f.key) === f.files) continue;
      this.seen.set(f.key, f.files);
      await this.ingest(f, f.files);
    }
    this.store.setState({ ready: folders.every((f) => f.files !== null || f.access !== 'granted') });
  }

  /** Rows for a folder's files (cached analyses shown at once), then the cache is checked against the files and the rest analyzed. */
  private async ingest(folder: FolderLike, files: NonNullable<FolderLike['files']>): Promise<void> {
    const key = folder.key;
    const generation = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, generation);
    this.ingests++;
    try {
      await this.loadUserAndPrefs();
      const record = readRecord(await this.storage.loadRecord(key).catch(() => undefined));
      this.records.set(key, record);
      const rows: BrowserRow[] = files.map((e) => this.rowFor(folder, e, record.files[e.path]?.[2] ?? null));
      this.store.setState((s) => ({ rows: inFolderOrder(this.folders.getState().folders, s.rows, key, rows) }));

      // The cache holds only what is unchanged: path, size and time must match.
      const idents: (FileIdentity & { file: File })[] = [];
      for (let i = 0; i < files.length; i += this.batch) {
        const part = files.slice(i, i + this.batch);
        const got = await Promise.all(
          part.map(async (e) => {
            try {
              const file = await e.handle.getFile();
              return { path: e.path, size: file.size, lastModified: file.lastModified, file };
            } catch {
              return null;
            }
          }),
        );
        if (this.generation.get(key) !== generation) return;
        for (const g of got) if (g) idents.push(g);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      const { hits, misses } = reconcile(record, idents);
      const pruned = prune(record, idents);
      if (Object.keys(pruned.files).length !== Object.keys(record.files).length) {
        this.records.set(key, pruned);
        this.dirty.add(key);
      }
      const missing = new Set(misses.map((m) => m.path));
      const unreadable = new Set(files.filter((e) => !idents.some((i) => i.path === e.path)).map((e) => e.path));
      // Rows whose cached analysis no longer fits the file (or whose file cannot be read) lose it.
      this.patchRows((r) => {
        if (r.folderKey !== key) return r;
        if (unreadable.has(r.path)) return { ...r, analysis: null, state: 'failed' };
        if (hits.has(r.path)) return r.state === 'ready' ? r : { ...r, state: 'ready' };
        if (missing.has(r.path)) return { ...r, analysis: null, state: 'pending' };
        return r;
      });
      if (misses.length > 0) {
        const rowsById = new Map(this.store.getState().rows.filter((r) => r.folderKey === key).map((r) => [r.path, r]));
        for (const m of misses) {
          const row = rowsById.get(m.path);
          if (row) this.queue.push({ row, ident: { path: m.path, size: m.size, lastModified: m.lastModified }, file: m.file, generation });
        }
        this.noteQueued(misses.length);
        this.pump();
      }
      if (this.dirty.has(key)) this.scheduleSave();
    } finally {
      this.ingests--;
      this.checkIdle();
    }
  }

  private rowFor(folder: FolderLike, e: { name: string; path: string; handle: FileHandleLike }, analysis: SampleAnalysis | null): BrowserRow {
    const id = `${folder.key}:${e.path}`;
    return {
      id,
      name: baseName(e.name),
      folder: folder.name,
      folderKey: folder.key,
      path: e.path,
      handle: e.handle,
      analysis,
      state: analysis ? 'ready' : 'pending',
      favorite: this.user.favorites.includes(id),
      userTags: this.user.tags[id] ?? [],
      lastUsed: this.user.lastUsed[id] ?? 0,
    };
  }

  private noteQueued(n: number): void {
    if (!this.store.getState().progress.running) {
      this.runStart = this.now();
      this.live = { total: 0, done: 0, failed: 0 };
    }
    this.live.total += n;
    this.publishProgress(true);
  }

  private publishProgress(running: boolean): void {
    const secs = Math.max(0.001, (this.now() - this.runStart) / 1000);
    this.store.setState({ progress: { ...this.live, running, filesPerSec: Math.round(this.live.done / secs) } });
  }

  private pump(): void {
    this.runner ??= this.makeRunner();
    const limit = analysisWorkerCount() + 2;
    while (this.inFlight < limit && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (this.generation.get(job.row.folderKey) !== job.generation) {
        // The folder was read again or removed since: this job's result would be for rows that no longer exist.
        this.live.total--;
        continue;
      }
      this.inFlight++;
      void this.runner
        .run(job.file, job.row.path)
        .catch(() => null)
        .then((analysis) => {
          this.inFlight--;
          if (this.generation.get(job.row.folderKey) === job.generation) {
            this.pending.set(job.row.id, analysis);
            const record = this.records.get(job.row.folderKey);
            if (record && analysis) {
              cacheStore(record, job.ident, analysis);
              this.dirty.add(job.row.folderKey);
              this.scheduleSave();
            }
            this.scheduleFlush();
          }
          this.noteDone(analysis === null);
          this.pump();
        });
    }
    this.checkIdle();
  }

  private noteDone(failed: boolean): void {
    this.live.done++;
    if (failed) this.live.failed++;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushMs);
  }

  /** Puts the analyses that have come in into the rows (one update for the whole batch). */
  flush(): void {
    if (this.store.getState().progress.running) this.publishProgress(true);
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    this.patchRows((r) => {
      if (!batch.has(r.id)) return r;
      const analysis = batch.get(r.id) ?? null;
      return { ...r, analysis, state: analysis ? 'ready' : 'failed' };
    });
  }

  private checkIdle(): void {
    if (this.queue.length > 0 || this.inFlight > 0 || this.ingests > 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    if (this.store.getState().progress.running) this.publishProgress(false);
    void this.saveNow();
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves when no file is being read or analyzed (tests, and actions that need the analysis). */
  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0 && this.ingests === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, this.saveMs);
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const record = this.records.get(key);
      if (record) await this.storage.saveRecord(key, record).catch(() => {});
    }
  }

  /** Analyzes a folder again from scratch (after the analyzer changed, or when a result looks wrong). */
  async reanalyze(folderKey?: string): Promise<void> {
    const folders = this.folders.getState().folders.filter((f) => !folderKey || f.key === folderKey);
    for (const f of folders) {
      await this.storage.deleteRecord(f.key).catch(() => {});
      this.seen.delete(f.key);
    }
    await this.syncFolders();
  }

  // ---- Rows ----

  private patchRows(change: (r: BrowserRow) => BrowserRow): void {
    this.store.setState((s) => {
      let changed = false;
      const rows = s.rows.map((r) => {
        const n = change(r);
        if (n !== r) changed = true;
        return n;
      });
      return changed ? { rows } : s;
    });
  }

  rowById(id: string): BrowserRow | undefined {
    return this.store.getState().rows.find((r) => r.id === id);
  }

  /** A row by its id, its path (`Folder/Sub/file.wav`, with or without the extension) or its name; the first when several fit. */
  find(query: string): BrowserRow | undefined {
    const q = query.trim().toLowerCase();
    if (!q) return undefined;
    const rows = this.store.getState().rows;
    const strip = (x: string) => x.replace(/\.[^./]+$/, '');
    return (
      rows.find((r) => r.id === query) ??
      rows.find((r) => `${r.folder}/${r.path}`.toLowerCase() === q || r.path.toLowerCase() === q) ??
      rows.find((r) => strip(`${r.folder}/${r.path}`).toLowerCase() === q || strip(r.path).toLowerCase() === q) ??
      rows.find((r) => r.name.toLowerCase() === q)
    );
  }

  /** The rows the window shows: filtered and sorted (kept while nothing they depend on changed). */
  visibleRows(): BrowserRow[] {
    const { rows, filter, sort, descending } = this.store.getState();
    const c = this.visibleCache;
    if (c && c.rows === rows && c.filter === filter && c.sort === sort && c.descending === descending) return c.out;
    const out = browse(rows, filter, sort, descending) as BrowserRow[];
    this.visibleCache = { rows, filter, sort, descending, out };
    return out;
  }

  // ---- The view ----

  setFilter(patch: Partial<SampleFilter>): void {
    this.store.setState((s) => ({ filter: { ...s.filter, ...patch } }));
  }

  clearFilter(): void {
    this.store.setState({ filter: NO_FILTER });
  }

  setSort(sort: SampleSort, descending?: boolean): void {
    this.store.setState((s) => ({ sort, descending: descending ?? (s.sort === sort ? !s.descending : false) }));
    this.savePrefs();
  }

  setSelection(ids: string[], cursor?: string | null): void {
    this.store.setState((s) => ({ selected: ids, cursor: cursor === undefined ? s.cursor : cursor }));
  }

  setPlaying(id: string | null): void {
    this.store.setState({ playing: id });
  }

  /** Changes one of the audition settings (saved with the view). */
  setPrefs(patch: Partial<Pick<BrowserState, 'volume' | 'syncTempo' | 'syncMode' | 'inKey' | 'autoPreview'>>): void {
    this.store.setState(patch);
    this.savePrefs();
  }

  private prefsTimer: ReturnType<typeof setTimeout> | null = null;
  private savePrefs(): void {
    if (this.prefsTimer) clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => {
      this.prefsTimer = null;
      const s = this.store.getState();
      const prefs: ViewPrefs = { volume: s.volume, syncTempo: s.syncTempo, syncMode: s.syncMode, inKey: s.inKey, autoPreview: s.autoPreview, sort: s.sort, descending: s.descending };
      void this.storage.savePrefs(prefs).catch(() => {});
    }, 500);
  }

  // ---- Your marks on files ----

  private applyUser(): void {
    this.patchRows((r) => {
      const favorite = this.user.favorites.includes(r.id);
      const tags = this.user.tags[r.id] ?? [];
      const lastUsed = this.user.lastUsed[r.id] ?? 0;
      return favorite === r.favorite && lastUsed === r.lastUsed && tags.length === r.userTags.length && tags.every((t, i) => t === r.userTags[i]) ? r : { ...r, favorite, userTags: tags, lastUsed };
    });
  }

  private saveUser(): void {
    void this.storage.saveUser(this.user).catch(() => {});
    this.applyUser();
  }

  toggleFavorite(id: string, on?: boolean): void {
    const has = this.user.favorites.includes(id);
    const want = on ?? !has;
    if (want === has) return;
    this.user = { ...this.user, favorites: want ? [...this.user.favorites, id] : this.user.favorites.filter((x) => x !== id) };
    this.saveUser();
  }

  addTag(id: string, tag: string): boolean {
    const t = cleanTag(tag);
    if (!t) return false;
    const have = this.user.tags[id] ?? [];
    if (have.includes(t)) return false;
    this.user = { ...this.user, tags: { ...this.user.tags, [id]: [...have, t] } };
    this.saveUser();
    return true;
  }

  removeTag(id: string, tag: string): void {
    const have = this.user.tags[id] ?? [];
    if (!have.includes(tag)) return;
    const tags = { ...this.user.tags };
    const rest = have.filter((x) => x !== tag);
    if (rest.length > 0) tags[id] = rest;
    else delete tags[id];
    this.user = { ...this.user, tags };
    this.saveUser();
  }

  /** Notes that a sound was used (auditioned for real: placed in the project). */
  markUsed(ids: readonly string[]): void {
    const at = this.now();
    const lastUsed = { ...this.user.lastUsed };
    for (const id of ids) lastUsed[id] = at;
    // Keep the most recent ones only.
    const entries = Object.entries(lastUsed).sort((a, b) => b[1] - a[1]).slice(0, MAX_RECENT);
    this.user = { ...this.user, lastUsed: Object.fromEntries(entries) };
    this.saveUser();
  }

  /** Every tag you have used, with how many sounds carry it. */
  allTags(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.store.getState().rows) for (const t of r.userTags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}

/** All rows with `fresh` taking the place of `key`'s: folders in the order you added them, files by path within each. */
function inFolderOrder(folders: readonly FolderLike[], rows: readonly BrowserRow[], key: string, fresh: BrowserRow[]): BrowserRow[] {
  const byFolder = new Map<string, BrowserRow[]>();
  for (const r of rows) {
    if (r.folderKey === key) continue;
    const list = byFolder.get(r.folderKey);
    if (list) list.push(r);
    else byFolder.set(r.folderKey, [r]);
  }
  byFolder.set(key, fresh);
  return folders.flatMap((f) => byFolder.get(f.key) ?? []);
}
