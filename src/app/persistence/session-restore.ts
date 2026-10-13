import { SCHEMA_VERSION, type Project } from '@core/model/types';
import type { ViewState } from '../stores/view';
import type { PianoRollViewState } from '../stores/editor';
import type { Services } from '../services';

/**
 * Keeps the open project across page reloads (dev hot reloads, accidental refreshes) by mirroring it
 * into localStorage. Superseded by proper OPFS autosave + crash recovery in M6.
 */
const KEY = 'agstudio:session:v1';

type SavedView = Pick<ViewState, 'mode' | 'currentPatternId' | 'windows' | 'browser'> & {
  pianoRoll?: PianoRollViewState;
};

export interface SavedSession {
  project: Project;
  view: SavedView;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<SavedSession>;
    const p = data.project;
    if (!p || p.schemaVersion !== SCHEMA_VERSION || !p.channels || !p.patterns || !p.mixer || !p.playlist) return null;
    return { project: p, view: data.view as SavedView };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

export function installSessionSave(s: Services): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    const v = s.view.getState();
    const session: SavedSession = {
      project: s.doc.getState().project,
      view: {
        mode: v.mode,
        currentPatternId: v.currentPatternId,
        windows: v.windows,
        browser: v.browser,
        pianoRoll: s.editor.getState().pianoRoll,
      },
    };
    try {
      storage()?.setItem(KEY, JSON.stringify(session));
    } catch {
      /* quota or private mode: nothing to do */
    }
  };
  const schedule = () => {
    if (timer === undefined) timer = setTimeout(save, 400);
  };
  const offDoc = s.history.onChange(schedule);
  const offView = s.view.subscribe(schedule);
  const offEditor = s.editor.subscribe((next, prev) => {
    if (next.pianoRoll !== prev.pianoRoll) schedule();
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') save();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', save);
  return () => {
    offDoc();
    offView();
    offEditor();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', save);
    if (timer !== undefined) clearTimeout(timer);
  };
}
