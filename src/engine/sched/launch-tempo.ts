/**
 * The tempo a launched audio pass plays under. The launcher axis `u` counts on with the transport and never wraps, so
 * `u` is the song's tick shifted: song tick = start tick + (u − start u), wrapped at the loop end like the planner wraps
 * it. The song's tempo (with its automation) along that path, as a stepped map on `u`, is what the clip player needs to
 * follow the tempo the way a playlist clip does (rate changes at each step; 'stretch' copies are made for the tempo the
 * pass starts at). Pure.
 */
import { steppedTempo, type TempoStep } from '@core/time/tempo';
import { constantTempo, type TempoMap } from '@core/time/ppq';
import type { Timeline } from './core';

/** Steps one pass can have (a tempo ramp is a step per 1/16 note: sixteen bars of it is 256). */
const MAX_STEPS = 4096;

/** Song tick reached `du` launcher ticks after `tick` (wrapping at the loop end; clamped to the end of a song that does not loop). */
export function advanceTick(tl: Timeline, tick: number, du: number): number {
  const L = tl.loop && tl.loop.end > tl.loop.start ? tl.loop : null;
  if (!L) return Math.min(tick + du, tl.endTick);
  let t = tick;
  if (t >= L.end || t < L.start) t = L.start;
  const span = L.end - L.start;
  return L.start + ((t - L.start + du) % span);
}

/** The song tick `du` launcher ticks before `tick` (the inverse of `advanceTick`; a song that does not loop stops at 0). */
export function retreatTick(tl: Timeline, tick: number, du: number): number {
  const L = tl.loop && tl.loop.end > tl.loop.start ? tl.loop : null;
  if (!L) return Math.max(0, tick - du);
  const span = L.end - L.start;
  const t = tick >= L.end || tick < L.start ? L.start : tick;
  return L.start + ((((t - L.start - du) % span) + span) % span);
}

/**
 * The tempo map of launcher ticks [uStart, uEnd] for a pass whose start is song tick `tickAtStart`. A map that never
 * changes in that span is a plain constant one. The first step is at tick 0 (as `steppedTempo` wants): the map is only
 * meaningful as differences, which is all the clip player reads.
 */
export function launchPassTempo(tl: Timeline, tickAtStart: number, uStart: number, uEnd: number): TempoMap {
  const tempo = tl.tempo;
  const L = tl.loop && tl.loop.end > tl.loop.start ? tl.loop : null;
  const limit = L ? L.end : tl.endTick;
  let tick = L && (tickAtStart >= L.end || tickAtStart < L.start) ? L.start : tickAtStart;
  let u = uStart;
  const steps: TempoStep[] = [];
  for (let guard = 0; u < uEnd && guard < MAX_STEPS; guard++) {
    steps.push({ tick: u, bpm: tempo.bpmAt(tick) });
    const to = Math.min(tempo.nextChange(tick), limit);
    const step = to > tick ? to - tick : Infinity;
    if (!Number.isFinite(step)) break;
    u += step;
    tick = to;
    if (L && tick >= L.end) tick = L.start;
    if (!L && tick >= limit) break;
  }
  const first = steps[0]?.bpm ?? tempo.bpmAt(tickAtStart);
  if (steps.every((s) => s.bpm === first)) return constantTempo(Math.round(first * 1e6) / 1e6);
  return steppedTempo(steps);
}
