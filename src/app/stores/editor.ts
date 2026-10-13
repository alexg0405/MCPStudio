import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Clip, ClipId, Note, NoteId, Tick } from '@core/model/types';
import type { Snap } from '@core/time/snap';
import { TICKS_PER_STEP } from '@core/time/ppq';

/** Editor state for the piano roll (and later the playlist): tools, snap, zoom, selection, clipboard. */
export type PianoRollTool = 'draw' | 'paint' | 'delete' | 'slice' | 'select';

export interface PianoRollViewState {
  tool: PianoRollTool;
  snap: Snap;
  ghosts: boolean;
  /** Length used for new notes (FL: the last note length you drew or resized). */
  lastLength: Tick;
  pxPerTick: number;
  rowHeight: number;
  scrollTick: number;
  /** Top visible row (0 = key 127); null = center on the content when first shown. */
  scrollRow: number | null;
  velocityLane: boolean;
}

export type PlaylistTool = PianoRollTool;

export interface PlaylistViewState {
  tool: PlaylistTool;
  snap: Snap;
  pxPerTick: number;
  laneHeight: number;
  scrollTick: number;
  scrollLane: number;
}

export interface EditorState {
  pianoRoll: PianoRollViewState;
  playlist: PlaylistViewState;
  clipSelection: readonly ClipId[];
  /** Copied clips, starts relative to the first one. */
  clipClipboard: readonly Clip[] | null;
  /** Selected notes of the piano roll's channel in the current pattern. Not undoable. */
  noteSelection: readonly NoteId[];
  /** Copied notes, ticks relative to the first one. */
  noteClipboard: readonly Note[] | null;
}

export interface EditorActions {
  setPianoRoll(patch: Partial<PianoRollViewState>): void;
  setPlaylist(patch: Partial<PlaylistViewState>): void;
  selectClips(ids: readonly ClipId[]): void;
  setClipClipboard(clips: readonly Clip[] | null): void;
  selectNotes(ids: readonly NoteId[]): void;
  setNoteClipboard(notes: readonly Note[] | null): void;
}

export type EditorStore = StoreApi<EditorState & EditorActions>;

export const defaultPianoRoll = (): PianoRollViewState => ({
  tool: 'draw',
  snap: 'auto',
  ghosts: true,
  lastLength: TICKS_PER_STEP,
  pxPerTick: 0.1,
  rowHeight: 14,
  scrollTick: 0,
  scrollRow: null,
  velocityLane: true,
});

export const defaultPlaylist = (): PlaylistViewState => ({
  tool: 'draw',
  snap: 'auto',
  pxPerTick: 0.025,
  laneHeight: 36,
  scrollTick: 0,
  scrollLane: 0,
});

export function createEditorStore(
  initial: Partial<PianoRollViewState> = {},
  playlist: Partial<PlaylistViewState> = {},
): EditorStore {
  return createStore<EditorState & EditorActions>()((set, get) => ({
    pianoRoll: { ...defaultPianoRoll(), ...initial },
    playlist: { ...defaultPlaylist(), ...playlist },
    noteSelection: [],
    noteClipboard: null,
    clipSelection: [],
    clipClipboard: null,
    setPlaylist(patch) {
      const cur = get().playlist;
      let changed = false;
      for (const k of Object.keys(patch) as (keyof PlaylistViewState)[]) if (patch[k] !== cur[k]) changed = true;
      if (changed) set({ playlist: { ...cur, ...patch } });
    },
    selectClips(ids) {
      const cur = get().clipSelection;
      if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return;
      set({ clipSelection: ids });
    },
    setClipClipboard(clips) {
      set({ clipClipboard: clips });
    },
    setPianoRoll(patch) {
      const cur = get().pianoRoll;
      let changed = false;
      for (const k of Object.keys(patch) as (keyof PianoRollViewState)[]) if (patch[k] !== cur[k]) changed = true;
      if (changed) set({ pianoRoll: { ...cur, ...patch } });
    },
    selectNotes(ids) {
      const cur = get().noteSelection;
      if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return;
      set({ noteSelection: ids });
    },
    setNoteClipboard(notes) {
      set({ noteClipboard: notes });
    },
  }));
}
