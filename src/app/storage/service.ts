import { createStore, type StoreApi } from 'zustand/vanilla';
import { createOpfsDerivedStore } from '@platform/derived-store';
import { isIdbAvailable } from '@platform/idb';
import { heldSessionLocks, isWebLocksAvailable } from '@platform/locks';
import { isOpfsAvailable, opfsStorage } from '@platform/opfs';
import type { Services } from '../services';
import { installBlobGuard } from '../persistence/blob-store';
import { isBusy } from './busy';
import { collectGarbage, previewCollection, type CollectResult, type CollectorDeps, type Preview } from './collector';
import { createBlobGuard } from './guard';
import { idbKv, LAST_RUN_KEY, type GcKv, type GcLastRun } from './kv';
import { startTabRefs, type TabRefs } from './tab-refs';
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
}

let current: StorageService | null = null;

/** The running service, or null before `installStorage` (tests) and where clean-up isn't supported. */
export function storageService(): StorageService | null {
  return current;
}

export function isStorageCleanupSupported(): boolean {
  return isOpfsAvailable() && isIdbAvailable() && isWebLocksAvailable();
}

/**
 * Starts this tab's part of the clean-up of unused audio: publishes what the tab uses, guards the sample
 * store, and (when allowed) runs the automatic clean-up at idle. Without OPFS, IndexedDB or Web Locks it
 * does nothing, and nothing is ever deleted.
 */
export function installStorage(s: Services, sessionId: string, opts: StorageOptions = {}): StorageService {
  const supported = isStorageCleanupSupported();
  const kv = opts.kv ?? idbKv;
  const status = createStore<StorageStatus>(() => ({
    supported,
    running: null,
    lastRun: null,
    dryRunOnly: opts.dryRunOnly === true,
  }));
  const none: StorageService = {
    status,
    usage: () => Promise.reject(new Error('Storage clean-up is not available in this browser.')),
    preview: () => Promise.reject(new Error('Storage clean-up is not available in this browser.')),
    cleanUp: () => Promise.resolve({ status: 'skipped', reason: 'unsupported' }),
    publishNow: () => Promise.resolve(),
    stop: () => {},
  };
  if (!supported) return (current = none);

  installBlobGuard(createBlobGuard({ kv }));
  const refs: TabRefs = startTabRefs({
    id: sessionId,
    kv,
    project: () => s.doc.getState().project,
    history: s.history,
    subscribe: (fn) => {
      const offs = [s.history.onChange(fn), s.history.onStatus(fn), s.engine.subscribe(fn)];
      return () => offs.forEach((off) => off());
    },
    isPlaying: () => s.engine.playing,
  });

  const derived = createOpfsDerivedStore();
  const deps: CollectorDeps & { derived: typeof derived } = {
    kv,
    blobs: opfsStorage(),
    autosaves: { files: () => opfsStorage().autosaveFiles() },
    supported: true,
    heldTabs: heldSessionLocks,
    self: { id: sessionId, record: refs.record },
    log: (m) => console.info(m),
    derived,
  };

  const readLastRun = async () => {
    const got = await kv.getMany([LAST_RUN_KEY]).catch(() => new Map<string, unknown>());
    const v = got.get(LAST_RUN_KEY) as GcLastRun | undefined;
    status.setState({ lastRun: v && typeof v.at === 'number' ? v : null });
    return v ?? null;
  };
  void readLastRun();

  const pause = () => new Promise<void>((r) => setTimeout(r, 40));
  const run = async (auto: boolean): Promise<CollectResult> => {
    if (status.getState().running) return { status: 'skipped', reason: 'locked' };
    status.setState({ running: { done: 0, total: 0 } });
    try {
      return await collectGarbage(deps, {
        idle: auto,
        dryRun: auto && opts.dryRunOnly === true,
        batch: auto ? 10 : 25,
        shouldStop: () => s.engine.playing && auto,
        pause,
        onProgress: (done, total) => status.setState({ running: { done, total } }),
      });
    } finally {
      status.setState({ running: null });
      void readLastRun();
    }
  };

  // ---- Automatic clean-up: at idle, every few hours, never while playing or exporting.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      if (s.prefs.getState().autoCleanup && !s.engine.playing && !isBusy()) {
        const last = await readLastRun();
        if (!last || Date.now() - last.at >= AUTO_INTERVAL_MS) {
          await new Promise<void>((resolve) => {
            if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 10_000 });
            else setTimeout(resolve, 0);
          });
          if (!s.engine.playing && !isBusy()) await run(true);
        }
      }
    } catch (e) {
      console.warn('Automatic cleanup of unused audio failed:', e);
    }
    if (!stopped) timer = setTimeout(() => void tick(), CHECK_EVERY_MS);
  };
  timer = setTimeout(() => void tick(), opts.autoStartDelayMs ?? FIRST_RUN_DELAY_MS);

  const service: StorageService = {
    status,
    usage: () => measureUsage(deps),
    preview: async () => summarize(await previewCollection(deps)),
    cleanUp: () => run(false),
    publishNow: () => refs.publishNow(),
    stop() {
      stopped = true;
      clearTimeout(timer);
      refs.stop();
    },
  };
  return (current = service);
}

export type { StorageUsage };
