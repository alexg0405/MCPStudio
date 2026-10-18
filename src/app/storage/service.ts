import { createStore, type StoreApi } from 'zustand/vanilla';
import { createOpfsDerivedStore } from '@platform/derived-store';
import { isIdbAvailable } from '@platform/idb';
import { heldSessionLocks, isWebLocksAvailable } from '@platform/locks';
import { isOpfsAvailable, opfsStorage, type OpfsStorage } from '@platform/opfs';
import type { Services } from '../services';
import { installBlobGuard } from '../persistence/blob-store';
import { isBusy } from './busy';
import { collectGarbage, previewCollection, type CollectResult, type CollectorDeps, type Preview } from './collector';
import { createBlobGuard } from './guard';
import { idbKv, LAST_RUN_KEY, type GcKv, type GcLastRun } from './kv';
import { startTabRefs } from './tab-refs';
import { measureUsage, type StorageUsage } from './usage';

/** The first automatic clean-up waits this long after the tab opens (startup is busy enough). */
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
/** After that, at most one automatic clean-up in this long (across all tabs). */
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A tab that stays open checks again this often whether it is time. */
const CHECK_EVERY_MS = 30 * 60 * 1000;

export interface CleanupSummary {
  /** Files that would go now. */
  files: number;
  bytes: number;
  /** Unused files that are still inside the grace period. */
  waitingFiles: number;
  waitingBytes: number;
  /** Why a clean-up can't run right now, in plain words (a tab is busy), if so. */
  blocked?: string;
}

export interface StorageStatus {
  /** Clean-up works in this browser (OPFS, IndexedDB and Web Locks all exist). */
  supported: boolean;
  /** A clean-up is running: `done` of `total` files so far. */
  running: { done: number; total: number } | null;
  /** The last clean-up (this browser, any tab). */
  lastRun: GcLastRun | null;
  /** The automatic clean-up only logs what it would remove (development builds). */
  dryRunOnly: boolean;
}

export interface StorageService {
  readonly status: StoreApi<StorageStatus>;
  usage(): Promise<StorageUsage>;
  /** What "Clean up unused audio" would do now (nothing is changed). */
  preview(): Promise<CleanupSummary>;
  /** Removes unused audio now (what the confirm dialog asks for). */
  cleanUp(): Promise<CollectResult>;
  /** Publishes this tab's audio right away (e.g. after recovering a project). */
  publishNow(): Promise<void>;
  stop(): void;
}

/** Why a clean-up can't run right now, in plain words, by the reason the collector gives. */
export const BLOCKED_TEXT = {
  'tab-starting': 'Another AGstudio tab is still starting up. Try again in a moment.',
  busy: 'An export or import is running. Try again when it finishes.',
  playing: 'Sound is playing. Try again when it stops.',
} as const;

const summarize = (p: Preview): CleanupSummary => ({
  files: p.plan.remove.length,
  bytes: p.plan.removeBytes,
  waitingFiles: p.plan.waiting.length,
  waitingBytes: p.plan.waitingBytes,
  ...(p.blocked ? { blocked: BLOCKED_TEXT[p.blocked] } : {}),
});

export interface StorageOptions {
  /** Where the records live (default: IndexedDB). */
  kv?: GcKv;
  /** The automatic clean-up only logs (default: false). */
  dryRunOnly?: boolean;
  /** Replaces the idle timers (tests). */
  autoStartDelayMs?: number;
  /** Where blobs and autosaves live (default: the browser's OPFS root; tests pass a scratch folder). */
  storage?: OpfsStorage;
  /** The stretched-copies cache (default: OPFS `derived/`). */
  derived?: { usage(): Promise<{ files: number; bytes: number }> };
  /** Which tabs are alive (default: the session locks). */
  heldTabs?: () => Promise<Set<string>>;
  /** The clock (default: Date.now; tests move it forward to age audio). */
  now?: () => number;
}

let current: StorageService | null = null;

/** The running service, or null before `installStorage` (tests) and where clean-up isn't supported. */
export function storageService(): StorageService | null {
  return current;
}

/** Clean-up needs OPFS (the files), IndexedDB (the records) and Web Locks (to coordinate tabs). */
export function isStorageCleanupSupported(): boolean {
  return isOpfsAvailable() && isIdbAvailable() && isWebLocksAvailable();
}

/** The service where clean-up isn't supported: nothing runs and nothing is ever deleted. */
function unsupportedService(status: StoreApi<StorageStatus>): StorageService {
  const unavailable = () => Promise.reject(new Error('Storage clean-up is not available in this browser.'));
  return {
    status,
    usage: unavailable,
    preview: unavailable,
    cleanUp: () => Promise.resolve({ status: 'skipped', reason: 'unsupported' }),
    publishNow: () => Promise.resolve(),
    stop: () => {},
  };
}

/** Blobs per batch of a clean-up: smaller for the automatic one, which runs while the musician works. */
const AUTO_BATCH_SIZE = 10;
const MANUAL_BATCH_SIZE = 25;
/** Pause between batches, in ms, so the page can breathe. */
const BATCH_PAUSE_MS = 40;
/** How long the automatic clean-up waits for an idle moment before running anyway. */
const IDLE_WAIT_MS = 10_000;

/**
 * Starts this tab's part of the clean-up of unused audio: publishes what the tab uses, guards the sample
 * store, and (when allowed) runs the automatic clean-up at idle. Without OPFS, IndexedDB or Web Locks it
 * does nothing, and nothing is ever deleted.
 */
export function installStorage(s: Services, sessionId: string, opts: StorageOptions = {}): StorageService {
  const supported = isStorageCleanupSupported();
  const status = createStore<StorageStatus>(() => ({
    supported,
    running: null,
    lastRun: null,
    dryRunOnly: opts.dryRunOnly === true,
  }));
  if (!supported) return (current = unsupportedService(status));

  const kv = opts.kv ?? idbKv;
  const now = opts.now ?? Date.now;
  installBlobGuard(createBlobGuard({ kv, now }));
  const refs = startTabRefs({
    id: sessionId,
    kv,
    project: () => s.doc.getState().project,
    history: s.history,
    subscribe: (fn) => {
      const unsubscribes = [s.history.onChange(fn), s.history.onStatus(fn), s.engine.subscribe(fn)];
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    isPlaying: () => s.engine.playing,
    now,
  });

  const storage = opts.storage ?? opfsStorage();
  const derived = opts.derived ?? createOpfsDerivedStore();
  const deps: CollectorDeps & { derived: typeof derived } = {
    kv,
    blobs: storage,
    autosaves: { files: () => storage.autosaveFiles() },
    supported: true,
    heldTabs: opts.heldTabs ?? heldSessionLocks,
    self: { id: sessionId, record: refs.record },
    now,
    log: (message) => console.info(message),
    derived,
  };

  /** Reads the last clean-up's record into the status (and returns it). */
  const readLastRun = async () => {
    const got = await kv.getMany([LAST_RUN_KEY]).catch(() => new Map<string, unknown>());
    const lastRun = got.get(LAST_RUN_KEY) as GcLastRun | undefined;
    status.setState({ lastRun: lastRun && typeof lastRun.at === 'number' ? lastRun : null });
    return lastRun ?? null;
  };
  void readLastRun();

  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
  /** One clean-up, manual or automatic; only one runs at a time in this tab. */
  const run = async (isAutomatic: boolean): Promise<CollectResult> => {
    if (status.getState().running) return { status: 'skipped', reason: 'locked' };
    status.setState({ running: { done: 0, total: 0 } });
    try {
      return await collectGarbage(deps, {
        idle: isAutomatic,
        dryRun: isAutomatic && opts.dryRunOnly === true,
        batch: isAutomatic ? AUTO_BATCH_SIZE : MANUAL_BATCH_SIZE,
        shouldStop: () => s.engine.playing && isAutomatic,
        pause,
        onProgress: (done, total) => status.setState({ running: { done, total } }),
      });
    } finally {
      status.setState({ running: null });
      void readLastRun();
    }
  };

  const autoCleanup = startAutoCleanup(s, {
    now,
    readLastRun,
    run,
    firstDelayMs: opts.autoStartDelayMs ?? FIRST_RUN_DELAY_MS,
  });

  const service: StorageService = {
    status,
    usage: () => measureUsage(deps),
    preview: async () => summarize(await previewCollection(deps)),
    cleanUp: () => run(false),
    publishNow: () => refs.publishNow(),
    stop() {
      autoCleanup.stop();
      refs.stop();
    },
  };
  return (current = service);
}

/** What the automatic clean-up needs from the service. */
interface AutoCleanupDeps {
  now(): number;
  /** The last clean-up's record (any tab), or null. */
  readLastRun(): Promise<GcLastRun | null>;
  run(isAutomatic: boolean): Promise<CollectResult>;
  firstDelayMs: number;
}

/**
 * The automatic clean-up: at idle, every few hours (across all tabs), never while playing or exporting.
 * A first check after `firstDelayMs`, then one every half hour while the tab stays open.
 */
function startAutoCleanup(s: Services, deps: AutoCleanupDeps): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isStopped = false;
  const isWorkAllowed = () => !s.engine.playing && !isBusy();
  const tick = async () => {
    if (isStopped) return;
    try {
      if (s.prefs.getState().autoCleanup && isWorkAllowed()) {
        const last = await deps.readLastRun();
        if (!last || deps.now() - last.at >= AUTO_INTERVAL_MS) {
          await new Promise<void>((resolve) => {
            if (typeof requestIdleCallback === 'function')
              requestIdleCallback(() => resolve(), { timeout: IDLE_WAIT_MS });
            else setTimeout(resolve, 0);
          });
          if (isWorkAllowed()) await deps.run(true);
        }
      }
    } catch (e) {
      console.warn('Automatic cleanup of unused audio failed:', e);
    }
    if (!isStopped) timer = setTimeout(() => void tick(), CHECK_EVERY_MS);
  };
  timer = setTimeout(() => void tick(), deps.firstDelayMs);
  return {
    stop() {
      isStopped = true;
      clearTimeout(timer);
    },
  };
}

export type { StorageUsage };
