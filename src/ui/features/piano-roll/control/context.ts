/**
 * What the pieces of the piano roll editor share: the app's services, the elements it draws on, the viewport, the
 * mutable state of the interaction, and the few long-lived helpers (the playhead follow, the panned picture layers).
 * Each module in this folder does one job (drawing a layer, one tool's pointer handling, the piano keys, the event
 * lane...) and takes the `PianoRollContext`; `../controller.ts` builds it and wires the events.
 */
import type { Services } from '@app/services';
import type { ChannelId, Note, NoteId, Pattern, PatternId, Project, SongKey, Tick } from '@core/model/types';
import { type FollowFrame, PlayheadFollow, createFollowFrame } from '../../../timeline/follow';
import { PannedLayer } from '../../../timeline/panned';
import { PlayheadLine } from '../../../timeline/playhead-line';
import { Viewport } from '../../../timeline/viewport';
import { ViewportSaver } from '../../../timeline/viewport-saver';
import { KEYS_WIDTH } from '../layout';
import { rowForKey, type ScaleRows } from '../render';
import type { Drag } from './drag';

/** The canvases and elements the React shell gives the controller. */
export interface PianoRollElements {
  area: HTMLElement;
  gridHost: HTMLElement;
  ruler: HTMLCanvasElement;
  keys: HTMLCanvasElement;
  grid: HTMLCanvasElement;
  notes: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  velocity: HTMLCanvasElement;
  velocityHost: HTMLElement;
  /** Shows the value being drawn in the event lane (the controller owns its text). */
  laneValue: HTMLElement;
  playhead: HTMLElement;
  hscroll: HTMLElement;
  hthumb: HTMLElement;
}

/** What a right-click asks the piano roll window to show a menu for. */
export type PianoRollMenuRequest =
  | { kind: 'note'; channelId: ChannelId; patternId: PatternId; noteIds: readonly NoteId[]; tick: Tick; key: number }
  | { kind: 'empty'; channelId: ChannelId; patternId: PatternId; tick: Tick; key: number };

/** A place on screen a menu opens at. */
export interface ScreenPoint {
  clientX: number;
  clientY: number;
}

/** What the window plugs in: the menu to open for a right-click. */
export interface PianoRollHooks {
  onMenu: ((request: PianoRollMenuRequest, at: ScreenPoint) => void) | null;
}

/** The parts of the editor that are drawn separately, each redrawn only when marked dirty. */
export type Layer = 'grid' | 'notes' | 'overlay' | 'keys' | 'ruler' | 'lane';

/** The note under the pointer and where on it: its body, or the end (which resizes). */
export interface Hit {
  note: Note;
  zone: 'body' | 'end';
}

/** What is being edited right now: the selected instrument channel's notes in the current pattern. */
export interface EditTarget {
  project: Project;
  /** The selected channel when it is an instrument, else null. */
  channelId: ChannelId | null;
  /** The current pattern when it exists, else null. */
  patternId: PatternId | null;
  pattern: Pattern | undefined;
  /** The instrument's root key (the key its sample plays at), if any. */
  rootKey: number | null;
  /** The notes of that channel in that pattern, sorted by tick. */
  notes: readonly Note[];
  songKey: SongKey | null;
}

/** An edit target that has both a channel and a pattern: what the tools that write notes need. */
export interface WritableTarget extends EditTarget {
  channelId: ChannelId;
  patternId: PatternId;
}

/** The target as a writable one, or null when there is no instrument channel or no pattern to write to. */
export function asWritable(target: EditTarget): WritableTarget | null {
  const { channelId, patternId } = target;
  return channelId && patternId ? { ...target, channelId, patternId } : null;
}

/** The chord stamp's outline under the pointer: where the draw tool would put the chord. */
export interface StampHover {
  tick: Tick;
  length: Tick;
  keys: number[];
  name: string;
}

/** A piano key sounding because it is being auditioned (drawing or dragging a note) or held on the keys strip. */
export interface Audition {
  key: number;
  noteId: number;
  channelId: ChannelId;
}

/** `maxScrollTick` for the notes array it was computed from (it runs every frame while the view follows). */
export interface MaxTickMemo {
  notes: readonly Note[] | null;
  end: Tick;
  bar: Tick;
  result: Tick;
}

/** The mutable state of the interaction. Only the modules of this folder change it; the frame loop reads it. */
export interface PianoRollState {
  /** The layers to draw on the next frame. */
  dirty: Set<Layer>;
  /** What the pointer is doing, or null. */
  drag: Drag | null;
  /** The note under the pointer (when no drag is going). */
  hover: Hit | null;
  /** The notes as they will be after a move or resize in progress, by id; null when there is none. */
  preview: Map<NoteId, Note> | null;
  /** Notes about to be added: a copy being dragged, or the note being drawn. */
  previewAdds: Note[];
  /** Keys held on the keys strip, with the id of the note sounding for each. */
  pressedKeys: Map<number, number>;
  audition: Audition | null;
  /** The chord stamp's outline under the pointer. */
  stampHover: StampHover | null;
  /** The slice tool's cut line: x (px) of the grid line the click would cut at. */
  sliceLineX: number;
  /** The hint bar text last set from here, so it is only sent when it changes. */
  lastHint: string;
  /** The channel and pattern the view was last centered (or restored) for. */
  centeredFor: { channelId: ChannelId | null; patternId: PatternId | null } | null;
  /** The song key's rows for drawing, kept for the key object they came from. */
  scaleCache: { key: SongKey | null; rows: ScaleRows | null };
  maxTickMemo: MaxTickMemo;
  /** The scrollbar track's width and the event lane's height, measured when the layout changes. */
  scrollTrackWidth: number;
  laneHeight: number;
  /** The scroll the scrollbar thumb was last placed for (NaN: not yet). */
  lastBarScroll: number;
  /** Follow playhead: the view scrolled along while playing, so its scroll is saved once playback stops. */
  followMoved: boolean;
}

/** The four layers drawn once into a picture wider than the view and slid while the view scrolls. */
export interface PannedLayers {
  grid: PannedLayer;
  notes: PannedLayer;
  ruler: PannedLayer;
  lane: PannedLayer;
}

/** Everything a module of the piano roll editor can reach. */
export interface PianoRollContext {
  readonly s: Services;
  readonly els: PianoRollElements;
  readonly hooks: PianoRollHooks;
  readonly vp: Viewport;
  readonly state: PianoRollState;
  readonly layers: PannedLayers;
  /** Follow playhead: scrolls the view along while playing. */
  readonly follow: PlayheadFollow;
  /** The follow inputs of the frame, filled in place each frame (no object per frame). */
  readonly followFrame: FollowFrame;
  readonly playheadLine: PlayheadLine;
  readonly viewportSaver: ViewportSaver;
  /** Marks layers to be drawn on the next frame. */
  invalidate(...layers: Layer[]): void;
}

/** Zoom limits of the time axis (px per tick), and the row count (one per key). */
const MIN_PX_PER_TICK = 0.004;
const MAX_PX_PER_TICK = 2;
const KEY_ROWS = 128;
/** The key at the top of a fresh view: around the middle of the keyboard (C5). */
const DEFAULT_TOP_KEY = 72;

/** Builds the context: the viewport restored from the saved view, the layers on their canvases, the empty state. */
export function createPianoRollContext(s: Services, els: PianoRollElements, hooks: PianoRollHooks): PianoRollContext {
  const vp = new Viewport(KEY_ROWS, MIN_PX_PER_TICK, MAX_PX_PER_TICK);
  const saved = s.editor.getState().pianoRoll;
  vp.pxPerTick = saved.pxPerTick;
  vp.rowHeight = saved.rowHeight;
  vp.scrollTick = saved.scrollTick;
  vp.scrollRow = saved.scrollRow ?? rowForKey(DEFAULT_TOP_KEY);
  const state = createPianoRollState();
  const saveViewport = (): void => {
    s.editor.getState().setPianoRoll({
      pxPerTick: vp.pxPerTick,
      rowHeight: vp.rowHeight,
      scrollTick: vp.scrollTick,
      scrollRow: vp.scrollRow,
    });
  };
  return {
    s,
    els,
    hooks,
    vp,
    state,
    layers: {
      grid: new PannedLayer(els.grid),
      notes: new PannedLayer(els.notes),
      ruler: new PannedLayer(els.ruler, 'blit'),
      lane: new PannedLayer(els.velocity),
    },
    follow: new PlayheadFollow(),
    followFrame: createFollowFrame(),
    playheadLine: new PlayheadLine(els.playhead, KEYS_WIDTH),
    viewportSaver: new ViewportSaver(saveViewport),
    invalidate(...layers: Layer[]): void {
      for (const layer of layers) state.dirty.add(layer);
    },
  };
}

function createPianoRollState(): PianoRollState {
  return {
    dirty: new Set<Layer>(['grid', 'notes', 'overlay', 'keys', 'ruler', 'lane']),
    drag: null,
    hover: null,
    preview: null,
    previewAdds: [],
    pressedKeys: new Map<number, number>(),
    audition: null,
    stampHover: null,
    sliceLineX: 0,
    lastHint: '',
    centeredFor: null,
    scaleCache: { key: null, rows: null },
    maxTickMemo: { notes: null, end: -1, bar: -1, result: 0 },
    scrollTrackWidth: 0,
    laneHeight: 1,
    lastBarScroll: NaN,
    followMoved: false,
  };
}
