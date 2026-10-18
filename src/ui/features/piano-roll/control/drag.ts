/** The drags the piano roll can be in the middle of: what each one remembers while the pointer is down. */
import type { Gesture } from '@core/history/history';
import type { Note, NoteId } from '@core/model/types';

/** Move the selected notes (the anchor is the one the pointer grabbed); Shift copies them instead. */
export interface MoveDrag {
  kind: 'move';
  /** Where the pointer went down, in grid pixels. */
  x0: number;
  y0: number;
  anchor: Note;
  originals: Note[];
  /** Shift was held: the notes are copied, the originals stay. */
  duplicate: boolean;
  /** How far the notes are from where they were (ticks). */
  dTick: number;
  /** New key of each original. */
  keys: number[];
}

/** Resize the selected notes by their end. */
export interface ResizeDrag {
  kind: 'resize';
  x0: number;
  anchor: Note;
  originals: Note[];
  /** How far the end moved (ticks). */
  dTick: number;
}

/** Draw tool: the new note (or the notes of a chord) follows the pointer. */
export interface CreateDrag {
  kind: 'create';
  notes: Note[];
  /** Where in the note (ticks from its start) the pointer holds it. */
  grabOffset: number;
}

/** A rubber band on empty space; `base` is the selection it adds to (Ctrl/Cmd held). */
export interface MarqueeDrag {
  kind: 'marquee';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: NoteId[];
}

/** Paint tool: notes are stamped along the pointer's path (one undo step). */
export interface PaintDrag {
  kind: 'paint';
  gesture: Gesture;
  /** Cells ("tick:key") already stamped during this drag. */
  done: Set<string>;
  /** The tick of the last stamp, so a fast drag fills the cells it skipped. */
  lastTick: number;
  key: number;
}

/** Delete tool, or right button: notes under the pointer are removed as it passes (one undo step). */
export interface EraseDrag {
  kind: 'erase';
  gesture: Gesture;
  done: Set<NoteId>;
  /** Where the pointer went down, in screen pixels, to tell a click from a drag. */
  clientX: number;
  clientY: number;
  moved: boolean;
}

/** Mute tool: notes the pointer passes over are muted or unmuted (one undo step). */
export interface MuteDrag {
  kind: 'mute';
  gesture: Gesture;
  done: Set<NoteId>;
  /** What the notes become: muted (true) or sounding (false), decided by the note the drag started on. */
  muted: boolean;
}

/** Middle button: the view follows the pointer. */
export interface PanDrag {
  kind: 'pan';
  /** The pointer's last position, in screen pixels. */
  x: number;
  y: number;
}

/** Drawing values in the event lane under the grid (live history gesture). */
export interface LaneDrag {
  kind: 'lane';
  gesture: Gesture;
  /** The last x (px) a value was written at, so a fast drag covers the notes it skipped. */
  lastX: number;
  /** Right button: values go back to the lane's default instead of following the pointer. */
  reset: boolean;
}

/** A piano key on the left is held down. */
export interface KeysDrag {
  kind: 'keys';
  key: number;
}

/** Whatever the pointer is doing right now. */
export type Drag =
  | MoveDrag
  | ResizeDrag
  | CreateDrag
  | MarqueeDrag
  | PaintDrag
  | EraseDrag
  | MuteDrag
  | PanDrag
  | LaneDrag
  | KeysDrag;
