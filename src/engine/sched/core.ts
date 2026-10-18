/**
 * Pure scheduling core (no Web Audio): splits the time window [cursor.time, horizon) into tick
 * segments of constant tempo, split where the tempo changes and wrapping exactly at the loop end.
 * Unit-tested in Node.
 */
import type { TempoMap } from '@core/time/ppq';

/** What the planner plans against: a tempo map, a loop region and the song's end. */
export interface Timeline {
  /** The tempo (stepped; segments split at its changes). */
  tempo: TempoMap;
  /** Loop region in ticks, or null to play once until `endTick`. */
  loop: { start: number; end: number } | null;
  endTick: number;
}

/** The planning frontier: where the next segment starts. */
export interface Cursor {
  /** May be fractional: the planning frontier rarely lands on a whole tick. */
  tick: number;
  time: number;
  /** Incremented on every loop wrap; part of event identity. */
  iter: number;
}

/** A stretch of the timeline at one tempo, with the context time it starts playing at. */
export interface Segment {
  tick0: number;
  tick1: number;
  time0: number;
  iter: number;
  /** Seconds per tick (constant within a segment). */
  spt: number;
}

/** The segments planned up to a horizon, and where planning goes on. */
export interface Plan {
  segs: Segment[];
  next: Cursor;
  /** True when a non-looping timeline reached its end. */
  ended: boolean;
}

/** The context time at which a segment ends. */
export const segmentEndTime = (s: Segment) => s.time0 + (s.tick1 - s.tick0) * s.spt;

/** Plans the segments from the cursor up to `horizon` (a context time): split at tempo changes, wrapped at the loop end. */
export function plan(cursor: Cursor, horizon: number, tl: Timeline): Plan {
  const segs: Segment[] = [];
  const L = tl.loop && tl.loop.end > tl.loop.start ? tl.loop : null;
  let { tick, time, iter } = cursor;
  if (L && (tick >= L.end || tick < L.start)) tick = L.start;
  // Bounded: a degenerate timeline must never spin forever (tempo steps are 1/16 at the finest).
  for (let guard = 0; guard < 200_000; guard++) {
    const limit = L ? L.end : tl.endTick;
    const spt = tl.tempo.secondsPerTick(tick);
    const change = tl.tempo.nextChange(tick);
    const byTime = tick + Math.max(0, horizon - time) / spt;
    const stop = Math.min(byTime, limit, change);
    if (stop > tick) {
      segs.push({ tick0: tick, tick1: stop, time0: time, iter, spt });
      time += (stop - tick) * spt;
      tick = stop;
    }
    if (tick < limit) {
      // The horizon ends the plan; a tempo change only starts the next segment.
      if (stop === byTime || time >= horizon) return { segs, next: { tick, time, iter }, ended: false };
      continue;
    }
    if (!L) return { segs, next: { tick, time, iter }, ended: true };
    tick = L.start;
    iter++;
  }
  return { segs, next: { tick, time, iter }, ended: false };
}

/** Context time of a tick inside or after a segment, following the tempo map past its end. */
export function timeInSegment(seg: Segment, tick: number, tempo: TempoMap): number {
  if (tick <= seg.tick1) return seg.time0 + (tick - seg.tick0) * seg.spt;
  return segmentEndTime(seg) + (tempo.tickToSeconds(tick) - tempo.tickToSeconds(seg.tick1));
}

/** The newest segment that has started by `time` (its index), or -1 when none has. */
function segmentAt(segs: readonly Segment[], time: number): number {
  for (let i = segs.length - 1; i >= 0; i--) if (time >= (segs[i] as Segment).time0) return i;
  return -1;
}

/** The tick within segment `s` at `time` (clamped to the segment). */
function tickIn(s: Segment, time: number): number {
  const t = Math.min(time, segmentEndTime(s));
  return Math.min(s.tick1, s.tick0 + (t - s.time0) / s.spt);
}

/** Maps an audio-clock time to a tick using planned segments (newest last). */
export function tickAtTime(segs: readonly Segment[], time: number): { tick: number; iter: number } | null {
  const i = segmentAt(segs, time);
  if (i < 0) return null;
  const s = segs[i] as Segment;
  return { tick: tickIn(s, time), iter: s.iter };
}

/**
 * The tick at `time` as a plain number, null when no segment has started: `tickAtTime` without the result
 * object, for the playhead, which is asked for several times in every frame.
 */
export function tickNumberAt(segs: readonly Segment[], time: number): number | null {
  const i = segmentAt(segs, time);
  return i < 0 ? null : tickIn(segs[i] as Segment, time);
}
