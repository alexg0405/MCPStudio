/**
 * What the pieces of the playlist editor share: the app's services, the elements it draws on, the viewport, the
 * mutable state of the interaction (the drag, the hover, the markers as last drawn...), and the few long-lived helpers
 * (the playhead follow, the panned picture layers). Each module in this folder does one job (drawing a layer, one tool's
 * pointer handling, the ruler...) and takes the `PlaylistContext`; `../controller.ts` builds it and wires the events.
 */
import type { Services } from '@app/services';
import type { Clip, ClipId, LaneId, MarkerId, AutomationClip, Tick } from '@core/model/types';
import { type FollowFrame, PlayheadFollow, createFollowFrame } from '../../../timeline/follow';
import { PannedLayer } from '../../../timeline/panned';
import { PlayheadLine } from '../../../timeline/playhead-line';
import { Viewport } from '../../../timeline/viewport';
import { ViewportSaver } from '../../../timeline/viewport-saver';
import type { AudioHandle } from '../audio-clip';
import type { AutoHit } from '../automation';
import { HEADER_WIDTH } from '../layout';
import type { MarkerBox } from '../marker-flags';
import type { Drag } from './drag';

/** The canvases and elements the React shell gives the controller. */
export interface PlaylistElements {
  gridHost: HTMLElement;
  grid: HTMLCanvasElement;
  clips: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  headers: HTMLCanvasElement;
  ruler: HTMLCanvasElement;
  playhead: HTMLElement;
  hscroll: HTMLElement;
  hthumb: HTMLElement;
  rename: HTMLInputElement;
  /** Inline rename field for markers on the ruler. */
  markerRename: HTMLInputElement;
  /** The Ask AI pill over the selection or the loop region (moved on dirty frames). */
  askPill: HTMLElement;
}

/** A rect in client pixels. */
export interface ClientBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A place on screen a menu opens at. */
export interface ScreenPoint {
  clientX: number;
  clientY: number;
}

/**
 * What the window plugs in: menus to open and drops to handle. The controller does not know what they do (the menus
 * are built from the feature's menu code), it only says what was clicked.
 */
export interface PlaylistHooks {
  /** A sound dragged in from the browser: the window creates an audio clip for it. */
  onSampleDrop?: (generator: string, laneId: LaneId, tick: Tick) => void;
  /** Audio files dropped from the sample browser or the desktop. */
  onFilesDrop?: (files: Promise<File[]>, laneId: LaneId, tick: Tick) => void;
  /** The ▾ menu of a clip was clicked. */
  onClipMenu?: (clip: Clip, at: ScreenPoint) => void;
  /** An automation point was right-clicked. */
  onPointMenu?: (clip: AutomationClip, index: number, at: ScreenPoint) => void;
  /** A track name was right-clicked. */
  onLaneMenu?: (laneId: LaneId, at: ScreenPoint) => void;
  /** A marker on the ruler was right-clicked. */
  onMarkerMenu?: (id: MarkerId, at: ScreenPoint) => void;
  /** An empty spot of the ruler was right-clicked (at a snapped song tick). */
  onRulerMenu?: (tick: Tick, at: ScreenPoint) => void;
  /** An empty cell of the grid was clicked with the draw tool (at a snapped tick on a track): its menu. */
  onEmptyMenu?: (tick: Tick, laneId: LaneId, at: ScreenPoint) => void;
  /** A marker flag's Studio mark was clicked: ask the AI about its section. */
  onMarkerAsk?: (id: MarkerId, at: ScreenPoint) => void;
}

/** The parts of the editor that are drawn separately, each redrawn only when marked dirty. */
export type Layer = 'grid' | 'clips' | 'overlay' | 'headers' | 'ruler';

/** Where on a clip the pointer is: its body, or near its start or end edge (those resize). */
export type Zone = 'body' | 'start' | 'end';

/** The clip under the pointer and where on it. */
export interface Hit {
  clip: Clip;
  zone: Zone;
}

/** The automation clip part under the pointer (its points show, the hint bar explains it). */
export interface AutoHover {
  clipId: Clip['id'];
  hit: AutoHit;
}

/** A place on the playlist the keyboard cursor can be: a tick (on the snap grid) and a track row (-1 is the marker lane above the tracks). */
export interface ClipCursor {
  tick: Tick;
  row: number;
}

/** The keyboard cursor (see `key-cursor.ts`): where it is, the corner a Shift-extended selection started from, and whether it is shown. */
export interface PlaylistKeyboardState {
  cursor: ClipCursor;
  /** The cell a Shift + arrow selection grows from (null while no selection is being extended), and what was selected then. */
  anchor: ClipCursor | null;
  anchorSelection: readonly ClipId[];
  /** The grid has keyboard focus: the cursor is drawn and the keys are its. */
  isActive: boolean;
  /** The cursor has been put somewhere sensible (the first time the grid gets the keyboard focus). */
  isPlaced: boolean;
  /** The selection as it was when the keyboard last left the grid: a different one on return was made elsewhere (with the mouse). */
  selectionWhenLeft: readonly ClipId[] | null;
}

/** The mutable state of the interaction. Only the modules of this folder change it; the frame loop reads it. */
export interface PlaylistState {
  /** The keyboard cursor. */
  keyboard: PlaylistKeyboardState;
  /** The layers to draw on the next frame. */
  dirty: Set<Layer>;
  /** What the pointer is doing (a drag, a swipe...), or null. */
  drag: Drag | null;
  /** The clip under the pointer (when no drag is going). */
  hover: Hit | null;
  /** The clips as they will be after the drag in progress (moving, resizing, creating); null when there is none. */
  preview: Clip[] | null;
  /** The automation clip part under the pointer. */
  autoHover: AutoHover | null;
  /** The audio clip gain/fade handle under the pointer. */
  audioHot: { clipId: Clip['id']; handle: AudioHandle } | null;
  /** The hint bar text last set from here (so it is only emitted when it changes); null: the window's own. */
  lastHint: string | null;
  /** The slice tool's cut line: x (px) of the grid line the click would cut at, -1 when there is none. */
  sliceLineX: number;
  /** Marker flags as last drawn on the ruler (picture pixels), the one under the pointer, and one being dragged. */
  markerBoxes: MarkerBox[];
  markerHot: MarkerId | null;
  /** The pointer is on the hot marker's Studio mark. */
  markerAskHot: boolean;
  markerDrag: { id: MarkerId; tick: Tick } | null;
  /** The Ask AI pill's text as last set, and its width for that text. */
  pillLabel: string;
  pillWidth: number;
  /** The horizontal scrollbar's track width, measured when the layout changes. */
  scrollTrackWidth: number;
  /** The scroll the scrollbar thumb and the Ask AI pill were last placed for (NaN: not yet). */
  lastBarScroll: number;
  /** The device-pixel snap last written to the grid and the playhead's data attribute (NaN: none yet). */
  lastSnapPx: number;
  /** The overlay canvas is blank (so an idle redraw, as on every zoom or scroll frame, can be skipped). */
  overlayBlank: boolean;
  /** The track scroll and height the header canvas shows (it does not change with the horizontal view). */
  drawnHeaderRow: number;
  drawnHeaderRowHeight: number;
  /** Follow playhead: the view scrolled along while playing, so its scroll is saved once playback stops. */
  followMoved: boolean;
  wasPlaying: boolean;
}

/** The three layers drawn once into a picture wider than the view and slid while the view scrolls. */
export interface PannedLayers {
  grid: PannedLayer;
  clips: PannedLayer;
  ruler: PannedLayer;
}

/** Everything a module of the playlist editor can reach. */
export interface PlaylistContext {
  readonly s: Services;
  readonly els: PlaylistElements;
  readonly hooks: PlaylistHooks;
  readonly vp: Viewport;
  readonly state: PlaylistState;
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

/** Zoom limits of the playlist's time axis (px per tick) and the first row count (replaced as the tracks are known). */
const MIN_PX_PER_TICK = 0.0015;
const MAX_PX_PER_TICK = 0.5;

/** Builds the context: the viewport restored from the saved view, the layers on their canvases, the empty state. */
export function createPlaylistContext(s: Services, els: PlaylistElements, hooks: PlaylistHooks): PlaylistContext {
  const vp = new Viewport(32, MIN_PX_PER_TICK, MAX_PX_PER_TICK);
  const saved = s.editor.getState().playlist;
  vp.pxPerTick = saved.pxPerTick;
  vp.rowHeight = saved.laneHeight;
  vp.scrollTick = saved.scrollTick;
  vp.scrollRow = saved.scrollLane;
  const state = createPlaylistState();
  const saveViewport = (): void => {
    s.editor.getState().setPlaylist({
      pxPerTick: vp.pxPerTick,
      laneHeight: vp.rowHeight,
      scrollTick: vp.scrollTick,
      scrollLane: vp.scrollRow,
    });
  };
  return {
    s,
    els,
    hooks,
    vp,
    state,
    layers: { grid: new PannedLayer(els.grid), clips: new PannedLayer(els.clips), ruler: new PannedLayer(els.ruler, 'blit') },
    follow: new PlayheadFollow(),
    followFrame: createFollowFrame(),
    playheadLine: new PlayheadLine(els.playhead, HEADER_WIDTH),
    viewportSaver: new ViewportSaver(saveViewport),
    invalidate(...layers: Layer[]): void {
      for (const layer of layers) state.dirty.add(layer);
    },
  };
}

function createPlaylistState(): PlaylistState {
  return {
    keyboard: { cursor: { tick: 0, row: 0 }, anchor: null, anchorSelection: [], isActive: false, isPlaced: false, selectionWhenLeft: null },
    dirty: new Set<Layer>(['grid', 'clips', 'overlay', 'headers', 'ruler']),
    drag: null,
    hover: null,
    preview: null,
    autoHover: null,
    audioHot: null,
    lastHint: null,
    sliceLineX: -1,
    markerBoxes: [],
    markerHot: null,
    markerAskHot: false,
    markerDrag: null,
    pillLabel: '',
    pillWidth: 0,
    scrollTrackWidth: 0,
    lastBarScroll: NaN,
    lastSnapPx: NaN,
    overlayBlank: false,
    drawnHeaderRow: NaN,
    drawnHeaderRowHeight: NaN,
    followMoved: false,
    wasPlaying: false,
  };
}
