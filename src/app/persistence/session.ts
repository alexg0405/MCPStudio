import { APP_VERSION } from '@core/model/defaults';
import type { Project, SampleRef } from '@core/model/types';
import { migrateProject, repairProject } from '@core/schema/migrate';
import type { BlobStore } from '@platform/opfs';
import { heldSessionLocks, holdSessionLock, isWebLocksAvailable } from '@platform/locks';
import {
  deleteAutosave,
  isOpfsAvailable,
  listAutosaves,
  markAutosaveClean,
  requestPersistentStorage,
  writeAutosave,
  type AutosaveMeta,
} from '@platform/opfs';
import { sweepTempFiles } from '@platform/sinks';
import { projectJson } from '@core/io/project-json';
import { randomId } from '@core/model/ids';
import { UNTITLED } from '../project-files';
import type { Services } from '../services';
import { loadAutosave, pruneAutosaves, selectRecoveryCandidates, startAutosave, type Autosave } from './autosave';
import { findMissingSamples, missingSoundsNotice } from './project-io';
import { fileHandle } from './recent-files';
import { captureView } from './view-snapshot';

/**
 * Keeps work safe across reloads and crashes.
 *
 * - **Reload**: each tab mirrors its project, view and file link into sessionStorage (written
 *   synchronously on pagehide, so nothing is lost), and a reload (or a dev full reload) comes back
 *   exactly where it was, still saving to the same file.
 * - **Crash**: changes are autosaved into OPFS (autosave.ts) under this tab's session id, which the
 *   tab holds a Web Lock on. A later tab offers to recover sessions that ended without a clean
 *   shutdown (their lock is free and their newest autosave isn't marked clean).
 */

export type { AutosaveMeta };

const SESSION_ID_KEY = 'agstudio:session-id';
const SNAPSHOT_KEY = 'agstudio:tab-snapshot:v2';
/** Autosaves kept besides live and recoverable sessions. */
const KEEP_AUTOSAVES = 8;

/** The link between the open project and its file, saved with each snapshot. */
export interface SessionFile {
  name: string;
  fileKey: string | null;
  /** The project differs from the file (or has none). */
  dirty: boolean;
}

/** Whether the tab was playing when it went away, and where (so a reload can carry on). */
export interface SessionTransport {
  playing: boolean;
  /** The tick being heard. */
  tick: number;
  /** Date.now() when it was written. */
  at: number;
}

export interface RestoredProject {
  project: Project;
  view: unknown;
  file: SessionFile;
  handle: FileSystemFileHandle | null;
  transport?: SessionTransport;
  /** Samples whose audio isn't in the sample store (set when the project was read from an autosave). */
  missingSamples?: SampleRef[];
}

export interface SessionStart {
  sessionId: string;
  /** This tab's state before the reload, if any. */
  restored: RestoredProject | null;
  /** Sessions that crashed with unsaved work, newest first (one per project). */
  recovery: AutosaveMeta[];
}

function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sessionFile(v: unknown, fallbackName: string): SessionFile {
  const f = isRecord(v) ? v : {};
  return {
    name: typeof f.name === 'string' && f.name ? f.name : fallbackName,
    fileKey: typeof f.fileKey === 'string' ? f.fileKey : null,
    dirty: f.dirty !== false,
  };
}

/** Validates and repairs a project from storage; null when it can't be used. */
function usableProject(json: unknown): Project | null {
  try {
    return repairProject(migrateProject(json).project).project;
  } catch (e) {
    console.warn('Ignoring a stored project that cannot be read:', e);
    return null;
  }
}

function readSnapshot(): Omit<RestoredProject, 'handle'> | null {
  try {
    const raw = tabStorage()?.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const project = usableProject(data.project);
    if (!project) return null;
    const t = isRecord(data.transport) ? data.transport : null;
    const transport =
      t && typeof t.playing === 'boolean' && typeof t.tick === 'number' && typeof t.at === 'number'
        ? { playing: t.playing, tick: Math.max(0, t.tick), at: t.at }
        : undefined;
    return {
      project,
      view: data.view ?? null,
      file: sessionFile(data.file, project.meta.title),
      ...(transport ? { transport } : {}),
    };
  } catch {
    return null;
  }
}

/** Claims this tab's session id (kept across reloads) and takes its lock. */
async function claimSessionId(): Promise<string> {
  const storage = tabStorage();
  const stored = storage?.getItem(SESSION_ID_KEY) ?? null;
  const candidates = stored ? [stored, randomId('ses')] : [randomId('ses')];
  let id = candidates[candidates.length - 1] as string;
  if (isWebLocksAvailable()) {
    for (const c of candidates) {
      try {
        // Held until the tab goes away; the browser releases it on close or crash.
        await holdSessionLock(c);
        id = c;
        break;
      } catch {
        // A duplicated tab copies sessionStorage: the id belongs to the original, so take a new one.
      }
    }
  } else if (stored) id = stored;
  try {
    storage?.setItem(SESSION_ID_KEY, id);
  } catch {
    /* storage unavailable: a reload starts a new session */
  }
  return id;
}

/** Startup: claims the session and finds what to restore (this tab) or offer to recover (others). */
export async function startSession(): Promise<SessionStart> {
  const reloaded = tabStorage()?.getItem(SESSION_ID_KEY) != null;
  const sessionId = await claimSessionId();
  let restored: RestoredProject | null = null;
  const snapshot = readSnapshot();
  if (snapshot)
    restored = { ...snapshot, handle: snapshot.file.fileKey ? await fileHandle(snapshot.file.fileKey) : null };

  let recovery: AutosaveMeta[] = [];
  if (isOpfsAvailable()) {
    // Asks the browser not to evict samples and autosaves under storage pressure (Chrome decides
    // without a prompt).
    void requestPersistentStorage().catch(() => false);
    // Half-written stems of an export that a closed or crashed tab left behind.
    void sweepTempFiles();
    try {
      // The snapshot didn't fit in sessionStorage (very large projects): use this tab's own autosave.
      if (!restored && reloaded) restored = await restoreAutosave(sessionId);
      const metas = await listAutosaves();
      const held = isWebLocksAvailable() ? await heldSessionLocks() : new Set<string>();
      recovery = selectRecoveryCandidates(metas, held, sessionId);
      const protect = new Set([...held, sessionId, ...recovery.map((m) => m.sessionId)]);
      for (const id of pruneAutosaves(metas, KEEP_AUTOSAVES, protect)) await deleteAutosave(id).catch(() => {});
    } catch (e) {
      console.warn('Autosave storage is unavailable:', e);
    }
  }
  return { sessionId, restored, recovery };
}

async function restoreAutosave(sessionId: string): Promise<RestoredProject | null> {
  const saved = await loadAutosave(sessionId);
  if (!saved) return null;
  const view = isRecord(saved.view) ? saved.view : {};
  const file = sessionFile(view.session, saved.meta.title || UNTITLED);
  file.fileKey ??= saved.meta.fileKey ?? null;
  return {
    project: saved.project,
    view: saved.view,
    file,
    handle: file.fileKey ? await fileHandle(file.fileKey) : null,
    missingSamples: saved.missingSamples,
  };
}

/**
 * After a reload restore: which sounds couldn't be found, in plain words (null when all are there).
 * A restore from the autosave already knows; one from the tab snapshot checks the sample store.
 */
export async function restoredMissingNotice(restored: RestoredProject, store?: BlobStore): Promise<string | null> {
  const missing = restored.missingSamples ?? (await findMissingSamples(restored.project, store));
  return missingSoundsNotice(missing);
}

/** Loads another session's autosave (a recovery candidate). */
export function loadRecovery(meta: AutosaveMeta): Promise<RestoredProject | null> {
  return restoreAutosave(meta.sessionId);
}

/** Deletes a recovery candidate's autosave (the musician chose not to recover it). */
export function discardRecovery(meta: AutosaveMeta): Promise<void> {
  return deleteAutosave(meta.sessionId);
}

export interface SessionPersistence {
  /** Writes the autosave now (e.g. right after recovering another session's work). */
  flush(): Promise<void>;
  stop(): void;
}

/** Starts the reload snapshot and the crash autosave for this tab. */
export function installSessionPersistence(s: Services, sessionId: string): SessionPersistence {
  const fileInfo = (): SessionFile => {
    const f = s.files.store.getState();
    return { name: f.name, fileKey: f.fileKey, dirty: s.history.status().dirty };
  };
  const snapshot = startReloadSnapshot(s, fileInfo);
  const crashAutosave = isOpfsAvailable() ? startCrashAutosave(s, sessionId, fileInfo) : null;
  return {
    flush: () => crashAutosave?.autosave.flush() ?? Promise.resolve(),
    stop() {
      crashAutosave?.stop();
      snapshot.stop();
    },
  };
}

/** How long after a change the reload snapshot is scheduled, and the longest it then waits for an idle moment. */
const SNAPSHOT_DELAY_MS = 1000;
const SNAPSHOT_IDLE_TIMEOUT_MS = 4000;

/**
 * The reload snapshot: the project, view and file link mirrored into sessionStorage a second after changes (at
 * the next idle moment), and synchronously when the page is hidden.
 */
function startReloadSnapshot(s: Services, fileInfo: () => SessionFile): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleHandle: number | undefined;
  let isTooBig = false;
  const cancelScheduled = () => {
    clearTimeout(timer);
    timer = undefined;
    if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
    idleHandle = undefined;
  };
  const writeSnapshot = () => {
    cancelScheduled();
    const storage = tabStorage();
    if (!storage) return;
    try {
      const transport: SessionTransport = { playing: s.engine.playing, tick: s.engine.playhead(), at: Date.now() };
      // The same text as JSON.stringify of the whole object, but the project's part is the one made for this
      // version of the project already when only the view moved (the usual reason for a snapshot).
      const rest = JSON.stringify({ view: captureView(s), file: fileInfo(), transport });
      storage.setItem(SNAPSHOT_KEY, `{"project":${projectJson(s.doc.getState().project)},${rest.slice(1)}`);
      isTooBig = false;
    } catch {
      // Over the quota (huge project): the OPFS autosave covers reloads instead.
      if (!isTooBig) console.warn('Project too large for the reload snapshot; relying on autosave.');
      isTooBig = true;
      storage.removeItem(SNAPSHOT_KEY);
    }
  };
  // A second after the first change, at the next idle moment: serializing a big project is tens of milliseconds,
  // and it must not land in the middle of a drag or a playing frame.
  const scheduleSnapshot = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      if (typeof window.requestIdleCallback === 'function') {
        idleHandle = window.requestIdleCallback(writeSnapshot, { timeout: SNAPSHOT_IDLE_TIMEOUT_MS });
      } else {
        writeSnapshot();
      }
    }, SNAPSHOT_DELAY_MS);
  };
  const unsubscribes = [
    s.history.onChange(scheduleSnapshot),
    s.history.onStatus(scheduleSnapshot),
    s.view.subscribe(scheduleSnapshot),
    s.files.store.subscribe(scheduleSnapshot),
    s.editor.subscribe((next, prev) => {
      if (next.pianoRoll !== prev.pianoRoll || next.playlist !== prev.playlist) scheduleSnapshot();
    }),
  ];
  window.addEventListener('pagehide', writeSnapshot);
  unsubscribes.push(() => window.removeEventListener('pagehide', writeSnapshot));
  return {
    stop() {
      clearTimeout(timer);
      if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
  };
}

let lastTitled: { project: Project; title: string; copy: Project } | null = null;

/** The project with `title` as its title: the same object as last time while neither the project nor the title changed. */
function titledCopy(project: Project, title: string): Project {
  if (lastTitled && lastTitled.project === project && lastTitled.title === title) return lastTitled.copy;
  const copy = { ...project, meta: { ...project.meta, title } };
  lastTitled = { project, title, copy };
  return copy;
}

/**
 * The crash autosave into OPFS (autosave.ts) of unsaved work. A saved, opened or fresh project marks the old
 * crash copy clean, since it holds nothing worth recovering.
 */
function startCrashAutosave(
  s: Services,
  sessionId: string,
  fileInfo: () => SessionFile,
): { autosave: Autosave; stop(): void } {
  const autosave = startAutosave({
    sessionId,
    appVersion: APP_VERSION,
    storage: {
      writeAutosave,
      // Closing a tab with unsaved changes keeps them recoverable: only a saved project ends clean.
      markAutosaveClean: (id) => (s.history.status().dirty ? Promise.resolve() : markAutosaveClean(id)),
    },
    getSnapshot: () => {
      const project = s.doc.getState().project;
      const file = fileInfo();
      return {
        // The recovery prompt shows the title: use the file's name. The renamed copy is kept while the project and the
        // name stay the same, so the project's JSON text (made once per project object) is reused by the next autosave.
        project: titledCopy(project, file.name),
        view: { ...captureView(s), session: file },
      };
    },
    // Only unsaved work needs a crash copy (a clean project is in its file already).
    subscribe: (fn) => {
      const onChange = () => {
        if (s.history.status().dirty) fn();
      };
      const unsubscribes = [s.history.onChange(onChange), s.view.subscribe(onChange)];
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    fileKey: () => s.files.store.getState().fileKey ?? undefined,
    onError: (e) => console.warn('Autosave failed:', e),
  });
  // Saved, opened or started fresh: the old crash copy holds nothing worth recovering.
  const markCleanIfSaved = () => {
    if (!s.history.status().dirty) void markAutosaveClean(sessionId).catch(() => {});
  };
  const unsubscribes = [
    s.files.onSaved(markCleanIfSaved),
    s.history.onChange((change) => {
      if (change.origin === 'load') markCleanIfSaved();
    }),
  ];
  return {
    autosave,
    stop() {
      autosave.stop();
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
  };
}
