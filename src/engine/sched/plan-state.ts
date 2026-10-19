import type { Clip, LaneId, Tick } from '@core/model/types';
import type { Cursor, Segment, Timeline } from './core';
import type { NoteEvent } from './events';

/** A planned segment with the launcher axis position of its start (`u`: see core/launcher/run.ts). */
export type USegment = Segment & { u0: number };

/** A note or audio clip start the transport sent to its sink, remembered until it has both started and been released. */
export interface Scheduled {
  ev: NoteEvent;
  noteId: number;
  startTime: number;
  iter: number;
  /** Absolute end tick (may change on live edits). */
  endTick: number;
  offSent: boolean;
  /** Audio events: the playlist clip as it was when its sample started. */
  clip?: Clip;
  /** Audio events: how the channel played it (see playbackKey) and whether its speed follows the tempo. */
  audioKey?: string;
  follows?: boolean;
  /** Launcher notes: their end is a position on the launcher axis, not a song tick. */
  launch?: boolean;
  endU?: number;
  /** Song notes: where they started on the launcher axis, and the playlist track they belong to (a launcher track may take it over). */
  startU?: number;
  laneId?: LaneId;
}

/**
 * Where the transport is and what it has planned: the single source the planner writes and the position queries read.
 * Nothing in here knows about notes or the sink.
 */
export class PlanState {
  playing = false;
  /** Where planning has got to (null while stopped). */
  cursor: Cursor | null = null;
  /** The planned segments, oldest first; the past is kept a little for the playhead and the tempo readouts. */
  segs: USegment[] = [];
  /** The launcher axis position of the planning cursor. */
  uFrontier = 0;
  /** The position a stopped transport shows (and starts from). */
  stoppedTick: Tick = 0;

  /** `timeline` is the tempo map, loop and length being planned; setModel swaps it. */
  constructor(public timeline: Timeline) {}
}
