/** The drags the playlist can be in the middle of: what each one remembers while the pointer is down. */
import type { Gesture } from '@core/history/history';
import type { ClipLevels } from '@core/audio/envelope';
import type {
  AudioClip,
  AutomationChannel,
  AutomationClip,
  ChannelId,
  Clip,
  ClipId,
  LaneId,
  MarkerId,
  PatternClip,
  Tick,
} from '@core/model/types';
import type { AudioHandle } from '../audio-clip';
import type { AutoHit } from '../automation';
import type { ClipBox } from '../clip-geometry';

/** Move the selected clips (the anchor is the one the pointer grabbed); Shift copies them instead. */
export interface MoveDrag {
  kind: 'move';
  /** Where the pointer went down, in grid pixels. */
  x0: number;
  y0: number;
  anchor: Clip;
  originals: Clip[];
  /** Shift was held: the clips are copied, the originals stay. */
  duplicate: boolean;
  /** How far the clips are from where they were (ticks, and tracks). */
  dTick: number;
  dLane: number;
  /** Another window's drop target the pointer is over (see ui/clip-drop.ts): the clips are not moving then. */
  over: HTMLElement | null;
}

/** Resize the selected clips by one of their edges. */
export interface ResizeDrag {
  kind: 'resize';
  x0: number;
  anchor: Clip;
  originals: Clip[];
  side: 'start' | 'end';
  /** How far the edge moved (ticks). */
  dTick: number;
}

/** Draw tool, after a press on an empty cell turned into a drag: the new pattern clip follows the pointer. */
export interface CreateDrag {
  kind: 'create';
  clip: PatternClip;
  /** Where in the clip (ticks from its start) the pointer holds it. */
  grab: number;
}

/** Draw tool on an empty cell: a click opens the empty-spot menu, a drag places the current pattern. */
export interface PressDrag {
  kind: 'press';
  x0: number;
  y0: number;
  lane: LaneId;
  /** The snapped tick the new clip would start at. */
  tick: Tick;
  grab: number;
  moved: boolean;
}

/** A rubber band on empty space; `base` is the selection it adds to (Ctrl/Cmd held). */
export interface MarqueeDrag {
  kind: 'marquee';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: ClipId[];
}

/** Paint tool: the current pattern is stamped along the track as the pointer moves (one undo step). */
export interface PaintDrag {
  kind: 'paint';
  gesture: Gesture;
  lane: LaneId;
  /** The tick of the last stamp, so a fast drag fills the cells it skipped. */
  last: Tick;
  /** Cells (ticks) already stamped during this drag. */
  done: Set<Tick>;
}

/** Delete tool, or right button: clips under the pointer are removed as it passes (one undo step). */
export interface EraseDrag {
  kind: 'erase';
  gesture: Gesture;
  done: Set<ClipId>;
}

/** Middle button: the view follows the pointer. */
export interface PanDrag {
  kind: 'pan';
  /** The pointer's last position, in screen pixels. */
  x: number;
  y: number;
}

/** On the ruler: a drag sets the loop region (or the punch range with Alt); a click sets the song position. */
export interface LoopDrag {
  kind: 'loop';
  /** Where the drag started (snapped tick). */
  t0: Tick;
  moved: boolean;
  punch?: boolean;
}

/** Comp tool: swiping across a take to use that part of it (committed as one undo step). */
export interface CompDrag {
  kind: 'comp';
  clip: AudioClip;
  group: string;
  t0: Tick;
  t1: Tick;
  moved: boolean;
}

/** A marker flag on the ruler: a click jumps to it, a drag moves it. */
export interface MarkerDrag {
  kind: 'marker';
  id: MarkerId;
  x0: number;
  /** Where in the flag (ticks from the marker) the pointer holds it. */
  grab: number;
  tick: Tick;
  moved: boolean;
}

/** The value readout drawn next to the pointer while an automation point or curve is dragged. */
export interface Readout {
  x: number;
  y: number;
  text: string;
}

/** An audio clip's gain or fade handle: `now` previews the new levels, the clip changes on release. */
export interface LevelDrag {
  kind: 'level';
  clip: AudioClip;
  handle: AudioHandle;
  x0: number;
  y0: number;
  start: ClipLevels;
  now: ClipLevels;
}

/** An automation point is dragged (live history gesture). */
export interface PointDrag {
  kind: 'point';
  gesture: Gesture;
  clip: AutomationClip;
  channelId: ChannelId;
  index: number;
  readout: Readout | null;
}

/** A curve handle between two automation points is dragged up or down to bend the curve. */
export interface TensionDrag {
  kind: 'tension';
  gesture: Gesture;
  clip: AutomationClip;
  channelId: ChannelId;
  index: number;
  y0: number;
  /** The segment's tension when the drag started. */
  t0: number;
  /** +1 when dragging up bends a falling segment's curve up, −1 for a rising one. */
  sign: number;
  readout: Readout | null;
}

/** Whatever the pointer is doing right now (null in the playlist state: nothing). */
export type Drag =
  | MoveDrag
  | ResizeDrag
  | CreateDrag
  | PressDrag
  | MarqueeDrag
  | PaintDrag
  | EraseDrag
  | PanDrag
  | LoopDrag
  | CompDrag
  | MarkerDrag
  | LevelDrag
  | PointDrag
  | TensionDrag;

/** What the pointer is over inside an automation clip. */
export interface AutoTarget {
  clip: AutomationClip;
  ch: AutomationChannel;
  box: ClipBox;
  hit: AutoHit;
}
