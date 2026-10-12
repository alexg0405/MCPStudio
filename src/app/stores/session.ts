import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChannelId } from '@core/model/types';

/** In-memory session state: never saved, never undoable. */
export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface SessionState {
  /** Text in the hint bar (hovered control's description). */
  hint: string;
  toasts: Toast[];
  /** The channel that receives keyboard/MIDI input and opens in the piano roll. */
  selectedChannelId: ChannelId | null;
}

export interface SessionActions {
  setHint(hint: string): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  selectChannel(id: ChannelId | null): void;
}

export type SessionStore = StoreApi<SessionState & SessionActions>;

let toastSeq = 0;

export function createSessionStore(): SessionStore {
  return createStore<SessionState & SessionActions>()((set, get) => ({
    hint: '',
    toasts: [],
    selectedChannelId: null,
    setHint(hint) {
      if (get().hint !== hint) set({ hint });
    },
    toast(text, kind = 'info') {
      const toast = { id: ++toastSeq, kind, text };
      set({ toasts: [...get().toasts, toast].slice(-4) });
      setTimeout(() => get().dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    selectChannel(id) {
      if (get().selectedChannelId !== id) set({ selectedChannelId: id });
    },
  }));
}
