/**
 * The beat grid of an exported range, for the video's beat-reactive pulse: the seconds (from the
 * start of the export) of every beat the tempo map puts in the range, with bar starts marked.
 * Follows tempo automation, because it goes through the TempoMap.
 */
import type { Tick, TimeSignature } from '../model/types';
import { ticksPerBar, ticksPerBeat, type TempoMap } from '../time/ppq';

/** The beats of an exported range: when each falls and which ones start a bar. */
export interface BeatGrid {
  /** Seconds from the start of the export, ascending. */
  times: Float64Array;
  /** 1 where the beat starts a bar. */
  strong: Uint8Array;
}

/** Every beat in [fromTick, toTick) (beats are the time signature's note: quarters in 4/4, eighths in 6/8). */
export function beatGrid(tempo: TempoMap, ts: TimeSignature, fromTick: Tick, toTick: Tick): BeatGrid {
  const beat = ticksPerBeat(ts);
  const bar = ticksPerBar(ts);
  const first = Math.ceil(fromTick / beat - 1e-9);
  const last = Math.ceil(toTick / beat - 1e-9) - 1;
  const count = Math.max(0, last - first + 1);
  const times = new Float64Array(count);
  const strong = new Uint8Array(count);
  const origin = tempo.tickToSeconds(fromTick);
  for (let k = 0; k < count; k++) {
    const tick = (first + k) * beat;
    times[k] = tempo.tickToSeconds(tick) - origin;
    strong[k] = tick % bar === 0 ? 1 : 0;
  }
  return { times, strong };
}

/**
 * How the picture should throb at one moment: the strength of the latest beat's pulse and where in that beat the moment
 * lies.
 */
export interface Pulse {
  /** 0…1: 1 on a beat (bar starts a bit more than the others), dying away until the next. */
  amount: number;
  /** Index of the latest beat at or before `t` (-1 before the first). */
  beat: number;
  /** How far through the beat, 0…1 (0 before the first beat). */
  phase: number;
}

/** Index of the last time ≤ t in a sorted array (-1 when t is before them all). */
export function lastAtOrBefore(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Strength of a bar's first beat and of the others. */
export const STRONG_PULSE = 1;
/** Pulse strength (0..1) of a beat that does not start a bar; a bar's first beat is 1. */
export const WEAK_PULSE = 0.62;
/** The pulse falls to 1/e of itself after this share of a beat... times DECAY, so it is ≈ 5 % by the next beat. */
const DECAY = 3;

/**
 * The pulse at time `t`: full strength on the beat, decaying with the time since it. The decay is a share
 * of the beat's length, so it follows the tempo (a slow song breathes slower).
 */
export function pulseAt(grid: BeatGrid, t: number): Pulse {
  const i = lastAtOrBefore(grid.times, t);
  if (i < 0) return { amount: 0, beat: -1, phase: 0 };
  const start = grid.times[i] as number;
  // The last beat has no next one: it lasts as long as the beat before it (or half a second).
  const length =
    i + 1 < grid.times.length
      ? (grid.times[i + 1] as number) - start
      : i > 0
        ? start - (grid.times[i - 1] as number)
        : 0.5;
  const span = Math.max(1e-3, length);
  const phase = (t - start) / span;
  const peak = grid.strong[i] ? STRONG_PULSE : WEAK_PULSE;
  return { amount: peak * Math.exp(-DECAY * phase), beat: i, phase: Math.min(1, phase) };
}
