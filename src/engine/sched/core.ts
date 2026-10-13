/**
 * Pure scheduling core (no Web Audio): splits the time window [cursor.time, horizon) into tick
 * segments of constant tempo, split where the tempo changes and wrapping exactly at the loop end.
 * Unit-tested in Node.
 */
import type { TempoMap } from '@core/time/ppq';

export interface Timeline {
  /** The tempo (stepped; segments split at its changes). */
  tempo: TempoMap;
  /** Loop region in ticks, or null to play once until `endTick`. */
  loop: { start: number; end: number } | null;
  endTick: number;
}

export interface Cursor {
  /** May be fractional: the planning frontier rarely lands on a whole tick. */
  tick: number;
  time: number;
  /** Incremented on every loop wrap; part of event identity. */
  iter: number;
}

export interface Segment {
  tick0: number;
  tick1: number;
  time0: number;
  iter: number;
  /** Seconds per tick (constant within a segment). */
  spt: number;
}

export interface Plan {
  segs: Segment[];
  next: Cursor;
  /** True when a non-looping timeline reached its end. */
  ended: boolean;
}

export const segmentEndTime = (s: Segment) => s.time0 + (s.tick1 - s.tick0) * s.spt;

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

/** Maps an audio-clock time to a tick using planned segments (newest last). */
export function tickAtTime(segs: readonly Segment[], time: number): { tick: number; iter: number } | null {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i] as Segment;
    if (time >= s.time0) {
      const end = segmentEndTime(s);
      const t = Math.min(time, end);
      return { tick: Math.min(s.tick1, s.tick0 + (t - s.time0) / s.spt), iter: s.iter };
    }
  }
  return null;
}
