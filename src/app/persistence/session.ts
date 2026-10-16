import { APP_VERSION } from '@core/model/defaults';
import type { Project } from '@core/model/types';
import { migrateProject, repairProject } from '@core/schema/migrate';
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
import { randomId } from '@core/model/ids';
import { UNTITLED } from '../project-files';
import type { Services } from '../services';
import { loadAutosave, pruneAutosaves, selectRecoveryCandidates, startAutosave, type Autosave } from './autosave';
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sessionFile(v: unknown, fallbackName: string): SessionFile {
  const f = isObj(v) ? v : {};
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
    const t = isObj(data.transport) ? data.transport : null;
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
  const view = isObj(saved.view) ? saved.view : {};
  const file = sessionFile(view.session, saved.meta.title || UNTITLED);
  file.fileKey ??= saved.meta.fileKey ?? null;
  return {
    project: saved.project,
    view: saved.view,
    file,
    handle: file.fileKey ? await fileHandle(file.fileKey) : null,
  };
}

/** Loads another session's autosave (a recovery candidate). */
export function loadRecovery(meta: AutosaveMeta): Promise<RestoredProject | null> {
  return restoreAutosave(meta.sessionId);
}

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

  // ---- Reload snapshot (sessionStorage, synchronous)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tooBig = false;
  const writeSnapshot = () => {
    clearTimeout(timer);
    timer = undefined;
    const storage = tabStorage();
    if (!storage) return;
    try {
      const transport: SessionTransport = { playing: s.engine.playing, tick: s.engine.playhead(), at: Date.now() };
      storage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({ project: s.doc.getState().project, view: captureView(s), file: fileInfo(), transport }),
      );
      tooBig = false;
    } catch {
      // Over the quota (huge project): the OPFS autosave covers reloads instead.
      if (!tooBig) console.warn('Project too large for the reload snapshot; relying on autosave.');
      tooBig = true;
      storage.removeItem(SNAPSHOT_KEY);
    }
  };
  const scheduleSnapshot = () => {
    timer ??= setTimeout(writeSnapshot, 1000);
  };
  const unsubs = [
    s.history.onChange(scheduleSnapshot),
    s.history.onStatus(scheduleSnapshot),
    s.view.subscribe(scheduleSnapshot),
    s.files.store.subscribe(scheduleSnapshot),
    s.editor.subscribe((next, prev) => {
      if (next.pianoRoll !== prev.pianoRoll || next.playlist !== prev.playlist) scheduleSnapshot();
    }),
  ];
  window.addEventListener('pagehide', writeSnapshot);
  unsubs.push(() => window.removeEventListener('pagehide', writeSnapshot));

  // ---- Crash autosave (OPFS)
  let autosave: Autosave | null = null;
  if (isOpfsAvailable()) {
    autosave = startAutosave({
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
          // The recovery prompt shows the title: use the file's name.
          project: { ...project, meta: { ...project.meta, title: file.name } },
          view: { ...captureView(s), session: file },
        };
      },
      // Only unsaved work needs a crash copy (a clean project is in its file already).
      subscribe: (fn) => {
        const onChange = () => {
          if (s.history.status().dirty) fn();
        };
        const offs = [s.history.onChange(onChange), s.view.subscribe(onChange)];
        return () => offs.forEach((off) => off());
      },
      fileKey: () => s.files.store.getState().fileKey ?? undefined,
      onError: (e) => console.warn('Autosave failed:', e),
    });
    // Saved, opened or started fresh: the old crash copy holds nothing worth recovering.
    const settle = () => {
      if (!s.history.status().dirty) void markAutosaveClean(sessionId).catch(() => {});
    };
    unsubs.push(
      s.files.onSaved(settle),
      s.history.onChange((c) => {
        if (c.origin === 'load') settle();
      }),
    );
  }

  return {
    flush: () => autosave?.flush() ?? Promise.resolve(),
    stop() {
      autosave?.stop();
      clearTimeout(timer);
      unsubs.forEach((u) => u());
    },
  };
}
