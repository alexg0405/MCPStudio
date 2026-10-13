import { writeProjectFile } from '@core/io/project-file';
import type { Project } from '@core/model/types';
import {
  StorageError,
  opfsStorage,
  type AutosaveMeta,
  type AutosaveSlot,
  type AutosaveStore,
  type BlobStore,
} from '@platform/opfs';
import { openProjectFile, type OpenedProject } from './project-io';

/**
 * Crash-safe autosave into OPFS. Saves 3 s after the last change, but at least every 30 s while
 * changes keep coming, and right away when the tab is hidden. Writes alternate between slots A and
 * B, so an interrupted write never destroys the previous save. Autosaves are "thin" project files:
 * samples stay in the sample store and are not copied into every save.
 *
 * Each tab also holds a session lock (platform/locks). On startup, sessions that are not marked
 * clean and whose lock nobody holds crashed: those are the recovery candidates.
 */

export const AUTOSAVE_DEBOUNCE_MS = 3_000;
export const AUTOSAVE_MAX_WAIT_MS = 30_000;

/** Page lifecycle hooks (injectable for tests). Each returns an unsubscribe function. */
export interface AutosaveLifecycle {
  onHidden(fn: () => void): () => void;
  onPageHide(fn: () => void): () => void;
}

export interface AutosaveOptions {
  sessionId: string;
  getSnapshot(): { project: Project; view: unknown };
  /** Subscribes to document and view changes; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  appVersion: string;
  /** IndexedDB key of the file handle the project belongs to, recorded for recovery. */
  fileKey?: () => string | undefined;
  /** Default: OPFS. */
  storage?: Pick<AutosaveStore, 'writeAutosave' | 'markAutosaveClean'>;
  /** Default: document visibilitychange and window pagehide. */
  lifecycle?: AutosaveLifecycle;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Write failures (default: console.warn). Unavailable storage is reported once, then autosave stops. */
  onError?(error: unknown): void;
  onSaved?(meta: AutosaveMeta): void;
}

export interface Autosave {
  /** Saves pending changes now (after any write in progress). Rejects when the write fails. */
  flush(): Promise<void>;
  /** Stops listening and cancels timers. Does not save: call flush() first if needed. */
  stop(): void;
}

export function browserLifecycle(): AutosaveLifecycle {
  return {
    onHidden(fn) {
      if (typeof document === 'undefined') return () => {};
      const listener = () => {
        if (document.visibilityState === 'hidden') fn();
      };
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    onPageHide(fn) {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('pagehide', fn);
      return () => window.removeEventListener('pagehide', fn);
    },
  };
}

export function startAutosave(opts: AutosaveOptions): Autosave {
  const debounceMs = opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  const storage = opts.storage ?? opfsStorage();
  const lifecycle = opts.lifecycle ?? browserLifecycle();
  const report = opts.onError ?? ((e: unknown) => console.warn('Autosave failed:', e));

  let dirty = false;
  let stopped = false;
  /** Storage is unavailable (e.g. no OPFS): reported once, then nothing more is attempted. */
  let disabled = false;
  let saved = false;
  let slot: AutosaveSlot = 'a';
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;

  const clearTimers = () => {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = maxWaitTimer = undefined;
  };
  const fire = () => {
    clearTimers();
    flush().catch(() => {}); // already reported
  };
  const onChange = () => {
    dirty = true;
    if (stopped || disabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, debounceMs);
    // The max-wait deadline counts from the first change since the last save.
    maxWaitTimer ??= setTimeout(fire, maxWaitMs);
  };

  /** A thin project file of the current state (samples stay in the sample store). */
  function encode(): { data: Uint8Array; meta: AutosaveMeta } {
    const { project, view } = opts.getSnapshot();
    const now = new Date();
    const meta: AutosaveMeta = {
      sessionId: opts.sessionId,
      projectId: project.projectId,
      title: project.meta.title,
      savedAt: now.toISOString(),
      clean: false,
      slot,
    };
    const fileKey = opts.fileKey?.();
    if (fileKey !== undefined) meta.fileKey = fileKey;
    return { data: writeProjectFile({ project, view, samples: new Map(), appVersion: opts.appVersion, now }), meta };
  }

  async function write(): Promise<void> {
    clearTimers();
    dirty = false;
    let file: { data: Uint8Array; meta: AutosaveMeta };
    try {
      file = encode();
      await storage.writeAutosave(opts.sessionId, slot, file.data, file.meta);
    } catch (e) {
      dirty = true;
      if (e instanceof StorageError && e.code === 'unavailable') disabled = true;
      else if (!stopped) {
        // Retry on the next change, or after the max wait without one (don't hammer a full disk).
        clearTimeout(maxWaitTimer);
        maxWaitTimer = setTimeout(fire, maxWaitMs);
      }
      report(e);
      throw e;
    }
    saved = true;
    // Only a successful write moves on: the other slot still holds the newest good save.
    slot = slot === 'a' ? 'b' : 'a';
    opts.onSaved?.(file.meta);
  }

  async function flush(): Promise<void> {
    while (inflight) await inflight.catch(() => {});
    if (!dirty || disabled) return;
    const pending = write();
    inflight = pending;
    try {
      await pending;
    } finally {
      if (inflight === pending) inflight = null;
    }
  }

  const unsubscribe = opts.subscribe(onChange);
  const offHidden = lifecycle.onHidden(() => {
    if (dirty) fire();
  });
  const offPageHide = lifecycle.onPageHide(() => {
    if (stopped) return;
    // Best effort: the page may be gone before this completes. If it doesn't, the session simply
    // stays a recovery candidate, which is the safe direction.
    void (async () => {
      try {
        await flush();
      } catch {
        return; // not saved, so not clean
      }
      if (dirty || disabled || !saved) return;
      try {
        await storage.markAutosaveClean(opts.sessionId);
      } catch (e) {
        report(e);
      }
    })();
  });

  return {
    flush,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
      unsubscribe();
      offHidden();
      offPageHide();
    },
  };
}

const savedTime = (m: AutosaveMeta) => {
  const t = Date.parse(m.savedAt);
  return Number.isNaN(t) ? -Infinity : t;
};
const newestFirst = (a: AutosaveMeta, b: AutosaveMeta) => savedTime(b) - savedTime(a);

/**
 * Autosaves worth offering for recovery: not marked clean, lock not held by a live tab, not this
 * session. Newest first, one per project (its newest).
 */
export function selectRecoveryCandidates(
  metas: readonly AutosaveMeta[],
  heldLocks: ReadonlySet<string>,
  currentSessionId: string,
): AutosaveMeta[] {
  const seen = new Set<string>();
  return metas
    .filter((m) => !m.clean && !heldLocks.has(m.sessionId) && m.sessionId !== currentSessionId)
    .sort(newestFirst)
    .filter((m) => {
      if (seen.has(m.projectId)) return false;
      seen.add(m.projectId);
      return true;
    });
}

/**
 * Session ids to delete so only the `keep` newest autosaves remain. Sessions in `protect` (this tab,
 * sessions whose lock is held) are never returned and don't count toward `keep`.
 */
export function pruneAutosaves(
  metas: readonly AutosaveMeta[],
  keep = 5,
  protect: ReadonlySet<string> = new Set(),
): string[] {
  return metas
    .filter((m) => !protect.has(m.sessionId))
    .sort(newestFirst)
    .slice(Math.max(0, keep))
    .map((m) => m.sessionId);
}

/** Reads a session's newest valid autosave as an opened project, or null when there is none. */
export async function loadAutosave(
  sessionId: string,
  opts: { storage?: Pick<AutosaveStore, 'readAutosave'>; store?: BlobStore } = {},
): Promise<(OpenedProject & { meta: AutosaveMeta }) | null> {
  const saved = await (opts.storage ?? opfsStorage()).readAutosave(sessionId);
  if (!saved) return null;
  return { ...(await openProjectFile(saved.data, { store: opts.store })), meta: saved.meta };
}
