/**
 * Piecewise-constant tempo maps. Tempo automation is evaluated once per 1/16 step into breakpoints
 * (equal neighbours merged), so the scheduler plans constant-tempo segments split at the changes and
 * seconds come from cumulative sums.
 */
import { PPQ, constantTempo, type TempoMap } from './ppq';
import type { Tick } from '../model/types';

export interface TempoStep {
  /** From this tick on… */
  tick: Tick;
  /** …the tempo is this. */
  bpm: number;
}

/** A tempo map from breakpoints (sorted by tick; the first should be at tick 0). */
export function steppedTempo(steps: readonly TempoStep[]): TempoMap {
  const merged: TempoStep[] = [];
  for (const s of steps) {
    if (!Number.isFinite(s.bpm) || s.bpm <= 0) continue;
    const last = merged[merged.length - 1];
    if (last && s.tick <= last.tick) {
      last.bpm = s.bpm;
      continue;
    }
    if (last && last.bpm === s.bpm) continue;
    merged.push({ tick: Math.max(0, s.tick), bpm: s.bpm });
  }
  if (merged.length === 0) return constantTempo(120);
  if (merged[0]!.tick > 0) merged.unshift({ tick: 0, bpm: merged[0]!.bpm });
  if (merged.length === 1) return constantTempo(merged[0]!.bpm);

  const n = merged.length;
  const ticks = new Float64Array(n);
  const spts = new Float64Array(n);
  const secs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = merged[i]!;
    ticks[i] = s.tick;
    spts[i] = 60 / (s.bpm * PPQ);
    secs[i] = i === 0 ? 0 : secs[i - 1]! + (s.tick - ticks[i - 1]!) * spts[i - 1]!;
  }
  /** Index of the last breakpoint at or before `tick`. */
  const at = (tick: Tick) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (ticks[mid]! <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    bpm: merged[0]!.bpm,
    constant: false,
    bpmAt: (tick) => merged[at(tick)]!.bpm,
    secondsPerTick: (tick) => spts[at(tick)]!,
    tickToSeconds(tick) {
      const i = at(tick);
      return secs[i]! + (tick - ticks[i]!) * spts[i]!;
    },
    secondsToTick(seconds) {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (secs[mid]! <= seconds) lo = mid;
        else hi = mid - 1;
      }
      return ticks[lo]! + (seconds - secs[lo]!) / spts[lo]!;
    },
    nextChange(tick) {
      const i = at(tick);
      return i + 1 < n ? ticks[i + 1]! : Infinity;
    },
  };
}

/** Seconds between two ticks. */
export function secondsBetween(map: TempoMap, t0: Tick, t1: Tick): number {
  return map.tickToSeconds(t1) - map.tickToSeconds(t0);
}

/** Whether two maps describe the same tempo (used to keep map identity stable across edits). */
export function sameTempo(a: TempoMap, b: TempoMap, until: Tick): boolean {
  if (a === b) return true;
  if (a.bpm !== b.bpm || a.constant !== b.constant) return false;
  let t = 0;
  for (let guard = 0; guard < 1_000_000 && t < until; guard++) {
    const na = a.nextChange(t);
    const nb = b.nextChange(t);
    if (na !== nb || a.bpmAt(t) !== b.bpmAt(t)) return false;
    if (na === Infinity) return true;
    t = na;
  }
  return true;
}
