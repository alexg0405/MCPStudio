import type { TempoMap } from '@core/time/ppq';
import { segmentEndTime, tickAtTime, tickNumberAt, type Segment } from './core';
import { advanceTick, launchPassTempo } from './launch-tempo';
import type { PlanState, USegment } from './plan-state';

/**
 * Questions about where the transport is, answered from what it has planned (no side effects): the tick heard at a
 * time, the tempo there, the position on the launcher axis and back. Some are read several times in every UI frame,
 * so they allocate as little as they can.
 */
export class PositionQueries {
  constructor(private readonly state: PlanState) {}

  /**
   * The tick (and loop pass) at audio-clock `time`, extrapolated at the current tempo before and
   * after what is planned; the stop position while stopped.
   */
  tickAt(time: number): { tick: number; iter: number } {
    const { segs, cursor, timeline } = this.state;
    if (!this.state.playing) return { tick: this.state.stoppedTick, iter: 0 };
    const hit = tickAtTime(segs, time);
    const last = segs[segs.length - 1];
    const first = segs[0];
    if (hit && !(last && time > segmentEndTime(last))) return hit;
    if (last && time > segmentEndTime(last))
      return { tick: last.tick1 + (time - segmentEndTime(last)) / last.spt, iter: last.iter };
    if (first) return { tick: first.tick0 - (first.time0 - time) / first.spt, iter: first.iter };
    return cursor
      ? { tick: cursor.tick + (time - cursor.time) / timeline.tempo.secondsPerTick(cursor.tick), iter: cursor.iter }
      : { tick: 0, iter: 0 };
  }

  /** Seconds per tick heard at audio-clock `time` (the timeline's tempo at the stop position when stopped). */
  sptAt(time: number): number {
    const { segs, cursor, timeline } = this.state;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i] as Segment;
      if (time >= s.time0) return s.spt;
    }
    const first = segs[0];
    return first ? first.spt : timeline.tempo.secondsPerTick(this.state.playing ? (cursor?.tick ?? 0) : this.state.stoppedTick);
  }

  /** Tick heard at audio-clock `time` (the UI passes the output-latency-corrected time). */
  positionAt(time: number): number {
    const { segs, cursor } = this.state;
    if (!this.state.playing) return this.state.stoppedTick;
    // A number, not the {tick, iter} object tickAtTime makes: this is read several times in every frame.
    const tick = tickNumberAt(segs, time);
    if (tick !== null) return tick;
    return segs[0]?.tick0 ?? cursor?.tick ?? this.state.stoppedTick;
  }

  /** The loop iteration heard at `time` (UI uses it for the current step light). */
  iterationAt(time: number): number {
    return tickAtTime(this.state.segs, time)?.iter ?? 0;
  }

  /**
   * The position on the launcher axis (see core/launcher/run.ts) at audio-clock `time`, extrapolated at the planned
   * tempo before and after what is planned. 0 while stopped.
   */
  uAtTime(time: number): number {
    if (!this.state.playing) return 0;
    const { segs, cursor, timeline, uFrontier } = this.state;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i] as USegment;
      if (time >= s.time0) {
        if (time <= segmentEndTime(s)) return s.u0 + (time - s.time0) / s.spt;
        return s.u0 + (s.tick1 - s.tick0) + (time - segmentEndTime(s)) / s.spt;
      }
    }
    const first = segs[0];
    if (first) return first.u0 - (first.time0 - time) / first.spt;
    return cursor ? uFrontier + (time - cursor.time) / timeline.tempo.secondsPerTick(cursor.tick) : uFrontier;
  }

  /**
   * The song tick launcher tick `u` is (or will be) played at: on the planned segments, past them by carrying the
   * plan on (loop wraps included).
   */
  tickAtU(u: number): number {
    if (!this.state.playing) return u;
    const { segs, cursor, timeline, uFrontier } = this.state;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i] as USegment;
      if (u >= s.u0 && u <= s.u0 + (s.tick1 - s.tick0)) return s.tick0 + (u - s.u0);
    }
    if (cursor && u >= uFrontier) return advanceTick(timeline, cursor.tick, u - uFrontier);
    const first = segs[0];
    return first ? Math.max(0, first.tick0 - (first.u0 - u)) : u;
  }

  /** The tempo a launched pass over launcher ticks [u0, u1] plays under, on the plan as it stands (see launch-tempo.ts). */
  launchTempo(u0: number, u1: number): TempoMap {
    return launchPassTempo(this.state.timeline, this.tickAtU(u0), u0, u1);
  }

  /** The context time of launcher tick `u` on the planned segments (null before the first one). */
  timeAtU(u: number): number | null {
    const { segs } = this.state;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i] as USegment;
      if (u >= s.u0) return s.time0 + (u - s.u0) * s.spt;
    }
    return null;
  }
}
