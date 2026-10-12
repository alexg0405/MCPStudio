import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Json } from '@core/model/json';
import type { PatternId } from '@core/model/types';
import type { Rect } from '@core/time/geometry';

/**
 * View state: window layout and editor settings. Saved alongside the project (view.json) but never
 * part of undo history.
 */

export interface WindowInstance {
  id: string;
  type: string;
  props: Json;
  /** null until the user moves/resizes it; the window type's default rect is used meanwhile. */
  rect: Rect | null;
  z: number;
  visible: boolean;
  maximized: boolean;
  /** Steps of the default position's cascade offset (used until the user moves the window). */
  cascade?: number;
}

export type TransportMode = 'pattern' | 'song';

export interface ViewState {
  /** FL's PAT/SONG switch: loop the current pattern, or play the playlist. */
  mode: TransportMode;
  /** The pattern shown in the channel rack / piano roll and looped in pattern mode. */
  currentPatternId: PatternId | null;
  windows: Record<string, WindowInstance>;
  focusedId: string | null;
  zTop: number;
  browser: { visible: boolean; width: number };
}

export interface ViewActions {
  /** Creates the window if needed, shows it and brings it to the front. */
  showWindow(id: string, type: string, props?: Json): void;
  /** FL-style toggle: hides the window if it is visible and focused, otherwise shows and focuses it. */
  toggleWindow(id: string, type: string, props?: Json): void;
  hideWindow(id: string): void;
  removeWindow(id: string): void;
  focusWindow(id: string | null): void;
  setRect(id: string, rect: Rect): void;
  setMaximized(id: string, maximized: boolean): void;
  setCascade(id: string, steps: number): void;
  setBrowser(patch: Partial<ViewState['browser']>): void;
  setMode(mode: TransportMode): void;
  setCurrentPattern(id: PatternId | null): void;
}

export type ViewStore = StoreApi<ViewState & ViewActions>;

export const defaultViewState = (): ViewState => ({
  mode: 'pattern',
  currentPatternId: null,
  windows: {},
  focusedId: null,
  zTop: 0,
  browser: { visible: true, width: 232 },
});

export function createViewStore(initial: Partial<ViewState> = {}): ViewStore {
  return createStore<ViewState & ViewActions>()((set, get) => {
    const raise = (id: string) => {
      const s = get();
      const w = s.windows[id];
      if (!w) return;
      if (s.focusedId === id && w.z === s.zTop && w.visible) return;
      const z = w.z === s.zTop && s.zTop > 0 ? w.z : s.zTop + 1;
      set({ windows: { ...s.windows, [id]: { ...w, z, visible: true } }, focusedId: id, zTop: Math.max(z, s.zTop) });
    };

    return {
      ...defaultViewState(),
      ...initial,

      showWindow(id, type, props = null) {
        const s = get();
        if (!s.windows[id]) {
          const z = s.zTop + 1;
          set({
            windows: { ...s.windows, [id]: { id, type, props, rect: null, z, visible: true, maximized: false } },
            focusedId: id,
            zTop: z,
          });
          return;
        }
        const w = s.windows[id];
        if (props !== null && w && w.props !== props) set({ windows: { ...s.windows, [id]: { ...w, props } } });
        raise(id);
      },

      toggleWindow(id, type, props) {
        const s = get();
        const w = s.windows[id];
        if (w?.visible && s.focusedId === id) get().hideWindow(id);
        else get().showWindow(id, type, props);
      },

      hideWindow(id) {
        const s = get();
        const w = s.windows[id];
        if (!w || !w.visible) return;
        const windows = { ...s.windows, [id]: { ...w, visible: false } };
        set({ windows, focusedId: s.focusedId === id ? topVisible(windows) : s.focusedId });
      },

      removeWindow(id) {
        const s = get();
        if (!s.windows[id]) return;
        const { [id]: _removed, ...windows } = s.windows;
        set({ windows, focusedId: s.focusedId === id ? topVisible(windows) : s.focusedId });
      },

      focusWindow(id) {
        if (id === null) {
          if (get().focusedId !== null) set({ focusedId: null });
          return;
        }
        raise(id);
      },

      setRect(id, rect) {
        const s = get();
        const w = s.windows[id];
        if (!w) return;
        set({ windows: { ...s.windows, [id]: { ...w, rect } } });
      },

      setMaximized(id, maximized) {
        const s = get();
        const w = s.windows[id];
        if (!w || w.maximized === maximized) return;
        set({ windows: { ...s.windows, [id]: { ...w, maximized } } });
      },

      setCascade(id, steps) {
        const s = get();
        const w = s.windows[id];
        if (w && w.cascade !== steps) set({ windows: { ...s.windows, [id]: { ...w, cascade: steps } } });
      },

      setBrowser(patch) {
        set({ browser: { ...get().browser, ...patch } });
      },

      setMode(mode) {
        if (get().mode !== mode) set({ mode });
      },

      setCurrentPattern(id) {
        if (get().currentPatternId !== id) set({ currentPatternId: id });
      },
    };
  });
}

function topVisible(windows: Record<string, WindowInstance>): string | null {
  let best: WindowInstance | null = null;
  for (const w of Object.values(windows)) if (w.visible && (!best || w.z > best.z)) best = w;
  return best?.id ?? null;
}
