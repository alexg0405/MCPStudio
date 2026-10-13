import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChannelId, Clip, ClipId, Note, NoteId, Tick } from '@core/model/types';
import type { Snap } from '@core/time/snap';
import { TICKS_PER_STEP } from '@core/time/ppq';

/** Editor state for the piano roll (and later the playlist): tools, snap, zoom, selection, clipboard. */
export type PlaylistTool = 'draw' | 'paint' | 'delete' | 'slice' | 'select';
export type PianoRollTool = PlaylistTool | 'mute';
export const PIANO_ROLL_TOOLS: readonly PianoRollTool[] = ['draw', 'paint', 'delete', 'mute', 'slice', 'select'];
export const PLAYLIST_TOOLS: readonly PlaylistTool[] = ['draw', 'paint', 'delete', 'slice', 'select'];

/** The note property the event lane under the piano roll shows and edits. */
export type NoteLane = 'velocity' | 'pan' | 'release' | 'fine';
export const NOTE_LANES: readonly NoteLane[] = ['velocity', 'pan', 'release', 'fine'];

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
  /** The event lane under the grid is shown. */
  velocityLane: boolean;
  /** What the event lane edits. */
  lane: NoteLane;
  /** Shade the rows of keys outside the song key's scale (and mark the root). */
  scaleHighlight: boolean;
  /** Drawn, painted and moved notes stay on the song key's scale. */
  scaleSnap: boolean;
  /**
   * Chord stamp: drawing a note draws this chord on it. '' = single notes, 'diatonic' / 'diatonic7'
   * = the song key's triads / seventh chords, anything else a chord id from `@agstudio/sdk/notes`.
   */
  chord: string;
  /** Inversion of the chord stamp (0–3). */
  inversion: number;
}

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
  /** The channel rack's graph editor: the channel whose per-step row is open (one at a time) and what it edits. */
  stepGraph: StepGraphState;
}

/** The property the channel rack's graph editor edits per step. */
export type StepLane = 'velocity' | 'pan' | 'release' | 'key' | 'fine';
export const STEP_LANES: readonly StepLane[] = ['velocity', 'pan', 'release', 'key', 'fine'];

export interface StepGraphState {
  channelId: ChannelId | null;
  lane: StepLane;
}

export interface EditorActions {
  setPianoRoll(patch: Partial<PianoRollViewState>): void;
  setPlaylist(patch: Partial<PlaylistViewState>): void;
  selectClips(ids: readonly ClipId[]): void;
  setClipClipboard(clips: readonly Clip[] | null): void;
  selectNotes(ids: readonly NoteId[]): void;
  setNoteClipboard(notes: readonly Note[] | null): void;
  setStepGraph(patch: Partial<StepGraphState>): void;
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
  lane: 'velocity',
  scaleHighlight: true,
  scaleSnap: false,
  chord: '',
  inversion: 0,
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
    stepGraph: { channelId: null, lane: 'velocity' },
    setStepGraph(patch) {
      const cur = get().stepGraph;
      if (Object.entries(patch).every(([k, v]) => cur[k as keyof StepGraphState] === v)) return;
      set({ stepGraph: { ...cur, ...patch } });
    },
  }));
}
