import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChannelId, Clip, ClipId, Note, NoteId, Tick } from '@core/model/types';
import type { Snap } from '@core/time/snap';
import { TICKS_PER_STEP } from '@core/time/ppq';

/** Editor state for the piano roll (and later the playlist): tools, snap, zoom, selection, clipboard. */
export type PlaylistTool = 'draw' | 'paint' | 'delete' | 'slice' | 'select' | 'comp';
export type PianoRollTool = Exclude<PlaylistTool, 'comp'> | 'mute';
export const PIANO_ROLL_TOOLS: readonly PianoRollTool[] = ['draw', 'paint', 'delete', 'mute', 'slice', 'select'];
export const PLAYLIST_TOOLS: readonly PlaylistTool[] = ['draw', 'paint', 'delete', 'slice', 'select', 'comp'];

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
  /** Scale lock: drawn, painted and moved notes stay on the song key's scale. */
  scaleSnap: boolean;
  /** Tint the rows of the chord track's notes behind the notes, and name the chords in the ruler. */
  chordHighlight: boolean;
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
  /** Take groups whose stack of take lanes is open under the comp lane (view state, not undoable). */
  openTakes: readonly string[];
  /**
   * The take clip being listened to on its own ("Listen to this take"): the engine plays the project with that take
   * unmuted and the rest of its recording silent (`auditionProject`). Session state, never saved or undoable.
   */
  auditionTake: ClipId | null;
  /**
   * Audio clips that play their original recording instead of the pitch-corrected render (the Pitch editor's A/B).
   * Session state, never saved or undoable; the engine hears `originalSound` of the project.
   */
  pitchOriginal: readonly ClipId[];
  /** Copied clips, starts relative to the first one. */
  clipClipboard: readonly Clip[] | null;
  /** Selected notes of the piano roll's channel in the current pattern. Not undoable. */
  noteSelection: readonly NoteId[];
  /** Copied notes, ticks relative to the first one. */
  noteClipboard: readonly Note[] | null;
  /** The channel rack's graph editor: the channel whose per-step row is open (one at a time) and what it edits. */
  stepGraph: StepGraphState;
  /** The chord lane above the playlist: shown, hidden, or (null) shown while the project has chords. View state, not undoable. */
  chordLane: boolean | null;
  /** The lyrics lane above the playlist: shown, hidden, or (null) shown while the project has lyrics. View state, not undoable. */
  lyricsLane: boolean | null;
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
  /** Opens or closes a take group's stack of take lanes. */
  setTakesOpen(group: string, open: boolean): void;
  setAuditionTake(clip: ClipId | null): void;
  setPitchOriginal(clip: ClipId, original: boolean): void;
  clearPitchOriginal(): void;
  setClipClipboard(clips: readonly Clip[] | null): void;
  selectNotes(ids: readonly NoteId[]): void;
  setNoteClipboard(notes: readonly Note[] | null): void;
  setStepGraph(patch: Partial<StepGraphState>): void;
  setChordLane(show: boolean | null): void;
  setLyricsLane(show: boolean | null): void;
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
  chordHighlight: true,
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
    openTakes: [],
    auditionTake: null,
    pitchOriginal: [],
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
    setTakesOpen(group, open) {
      const cur = get().openTakes;
      if (cur.includes(group) === open) return;
      set({ openTakes: open ? [...cur, group] : cur.filter((g) => g !== group) });
    },
    setAuditionTake(clip) {
      if (get().auditionTake !== clip) set({ auditionTake: clip });
    },
    setPitchOriginal(clip, original) {
      const cur = get().pitchOriginal;
      if (cur.includes(clip) === original) return;
      set({ pitchOriginal: original ? [...cur, clip] : cur.filter((c) => c !== clip) });
    },
    clearPitchOriginal() {
      if (get().pitchOriginal.length) set({ pitchOriginal: [] });
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
    chordLane: null,
    setChordLane(show) {
      if (get().chordLane !== show) set({ chordLane: show });
    },
    lyricsLane: null,
    setLyricsLane(show) {
      if (get().lyricsLane !== show) set({ lyricsLane: show });
    },
    setStepGraph(patch) {
      const cur = get().stepGraph;
      if (Object.entries(patch).every(([k, v]) => cur[k as keyof StepGraphState] === v)) return;
      set({ stepGraph: { ...cur, ...patch } });
    },
  }));
}
