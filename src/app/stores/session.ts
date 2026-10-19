import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChannelId, InsertId, SnapshotId } from '@core/model/types';

/** In-memory session state: never saved, never undoable. */
export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

/** The two mixer snapshots A/B compares, and which of them the mix is on now (null: neither was recalled yet). */
export interface SnapshotCompare {
  a: SnapshotId | null;
  b: SnapshotId | null;
  side: 'a' | 'b' | null;
}

export interface SessionState {
  /** Text in the hint bar (hovered control's description). */
  hint: string;
  toasts: Toast[];
  /** The channel that receives keyboard/MIDI input and opens in the piano roll. */
  selectedChannelId: ChannelId | null;
  /** The mixer insert whose effect slots the mixer shows (null = the master). */
  selectedInsertId: InsertId | null;
  /**
   * Tracks picked together in the mixer (Shift- or Ctrl-click on strips) for "Group" and "Link selected", in the
   * order picked. Empty: only the selected insert counts. Picking one track again with a plain click clears it.
   */
  markedInsertIds: InsertId[];
  /** The mixer snapshots the A/B toggle switches between. */
  snapshotCompare: SnapshotCompare;
}

export interface SessionActions {
  setHint(hint: string): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  selectChannel(id: ChannelId | null): void;
  selectInsert(id: InsertId | null): void;
  /** Adds the track to the picked ones, or takes it off them (the selected insert is the first pick). */
  toggleMarkedInsert(id: InsertId): void;
  /** Replaces the picked tracks (an empty list clears them). */
  markInserts(ids: readonly InsertId[]): void;
  setSnapshotCompare(patch: Partial<SnapshotCompare>): void;
}

export type SessionStore = StoreApi<SessionState & SessionActions>;

let toastSeq = 0;

export function createSessionStore(): SessionStore {
  return createStore<SessionState & SessionActions>()((set, get) => ({
    hint: '',
    toasts: [],
    selectedChannelId: null,
    selectedInsertId: null,
    markedInsertIds: [],
    snapshotCompare: { a: null, b: null, side: null },
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
    selectInsert(id) {
      const marked = get().markedInsertIds;
      if (get().selectedInsertId !== id || marked.length) set({ selectedInsertId: id, markedInsertIds: [] });
    },
    toggleMarkedInsert(id) {
      const { markedInsertIds, selectedInsertId } = get();
      const picked = markedInsertIds.length ? markedInsertIds : selectedInsertId ? [selectedInsertId] : [];
      const next = picked.includes(id) ? picked.filter((other) => other !== id) : [...picked, id];
      set({ markedInsertIds: next.length > 1 ? next : [] });
      // A lone pick is the selection itself.
      if (next.length === 1 && next[0] !== selectedInsertId) set({ selectedInsertId: next[0] ?? null });
    },
    markInserts(ids) {
      set({ markedInsertIds: ids.length > 1 ? [...ids] : [] });
    },
    setSnapshotCompare(patch) {
      set({ snapshotCompare: { ...get().snapshotCompare, ...patch } });
    },
  }));
}
