/**
 * The tempo of a planned mix in follow mode: the curve to write (holds and glides) and the steps the song's tempo map
 * makes of it.
 */
import type { Tick } from '../model/types';
import { PPQ } from '../time/ppq';
import { steppedTempo } from '../time/tempo';
import { BEATS_PER_BAR, roundBpm, ticksOf, TICKS_PER_BEAT, type Layout } from './plan-layout';
import type { MixPlan, TempoPoint } from './plan-types';

/** The largest tempo step inside a key-locked transition (as a share of the tempo). */
const KEY_LOCK_STEP_LIMIT = 0.01;
/** A key-locked transition steps its tempo at most this many times. */
const MAX_KEY_LOCK_STEPS = 8;
/** Tempo glides are evaluated once per 1/16 note. */
const GLIDE_STEP_TICKS = PPQ / 4;

/** The tempo curve to write, and the steps the song's tempo map makes of it. */
export interface TempoPlan {
  curve: MixPlan['tempoCurve'];
  steps: TempoPoint[];
}

/** One transition's tempo change: from and to (BPM), where the overlap starts and how long it is (ticks). */
interface TempoChange {
  fromBpm: number;
  toBpm: number;
  startTick: Tick;
  overlapTicks: number;
}

/**
 * The tempo of a layout in follow mode: the curve to write (holds and glides) and the steps the song's
 * tempo map makes of it. Glides are evaluated once per 1/16 step at its start, as `tempoMapOf` does;
 * with key lock the tempo moves in steps of at most 1 % on bar lines instead.
 */
export function tempoPlan(layout: Layout, keyLock: boolean): TempoPlan {
  const firstBpm = roundBpm(layout.songs[0]!.bpm);
  const curve: MixPlan['tempoCurve'] = [{ tick: 0, bpm: firstBpm, ramp: false }];
  const steps: TempoPoint[] = [{ tick: 0, bpm: firstBpm }];
  for (let i = 0; i < layout.songs.length - 1; i++) {
    const fromBpm = layout.songs[i]!.bpm;
    const toBpm = layout.songs[i + 1]!.bpm;
    const startTick = ticksOf(layout.placements[i]! + layout.exitBeats[i]!);
    const overlapTicks = layout.overlapBeats[i]! * TICKS_PER_BEAT;
    if (fromBpm !== toBpm && overlapTicks > 0) {
      if (keyLock) addKeyLockSteps(curve, steps, { fromBpm, toBpm, startTick, overlapTicks });
      else addGlide(curve, steps, { fromBpm, toBpm, startTick, overlapTicks });
    }
    curve.push({ tick: startTick + overlapTicks, bpm: roundBpm(toBpm), ramp: false });
    steps.push({ tick: startTick + overlapTicks, bpm: roundBpm(toBpm) });
  }
  return { curve: mergeCurve(curve), steps: mergeSteps(steps) };
}

/** Key lock: the tempo moves in steps of at most 1 % on bar lines (each clip piece is stretched at one constant tempo). */
function addKeyLockSteps(curve: MixPlan['tempoCurve'], steps: TempoPoint[], change: TempoChange): void {
  const { fromBpm, toBpm, startTick, overlapTicks } = change;
  const bars = overlapTicks / (BEATS_PER_BAR * TICKS_PER_BEAT);
  const stepCount = Math.max(1, Math.min(MAX_KEY_LOCK_STEPS, bars, Math.ceil(Math.abs(toBpm / fromBpm - 1) / KEY_LOCK_STEP_LIMIT - 1e-9)));
  for (let k = 0; k < stepCount; k++) {
    const tick = startTick + BEATS_PER_BAR * TICKS_PER_BEAT * Math.floor((k * bars) / stepCount);
    const bpm = roundBpm(fromBpm + ((toBpm - fromBpm) * (k + 0.5)) / stepCount);
    steps.push({ tick, bpm });
    curve.push({ tick, bpm, ramp: false });
  }
}

/** Turntable style: the curve glides linearly through the overlap; the tempo map follows in 1/16 steps. */
function addGlide(curve: MixPlan['tempoCurve'], steps: TempoPoint[], change: TempoChange): void {
  const { fromBpm, toBpm, startTick, overlapTicks } = change;
  curve.push({ tick: startTick, bpm: roundBpm(fromBpm), ramp: true });
  for (let t = 0; t < overlapTicks; t += GLIDE_STEP_TICKS) {
    steps.push({ tick: startTick + t, bpm: roundBpm(fromBpm + ((toBpm - fromBpm) * t) / overlapTicks) });
  }
}

/** Sorted, one per tick (the later wins), equal neighbours merged. */
function mergeSteps(points: TempoPoint[]): TempoPoint[] {
  const merged: TempoPoint[] = [];
  for (const point of points.slice().sort((a, b) => a.tick - b.tick)) {
    const last = merged[merged.length - 1];
    if (last && last.tick === point.tick) last.bpm = point.bpm;
    else if (!last || last.bpm !== point.bpm) merged.push({ ...point });
  }
  return merged;
}

/** Sorted, one per tick (the later wins), a point kept when the tempo changes or a glide starts or ends there. */
function mergeCurve(points: MixPlan['tempoCurve']): MixPlan['tempoCurve'] {
  const merged: MixPlan['tempoCurve'] = [];
  for (const point of points.slice().sort((a, b) => a.tick - b.tick)) {
    const last = merged[merged.length - 1];
    if (last && last.tick === point.tick) Object.assign(last, point);
    else if (!last || last.bpm !== point.bpm || last.ramp || point.ramp) merged.push({ ...point });
  }
  return merged;
}

/** How long a tempo curve takes to play `totalTicks` (seconds). */
export function durationOfTempo(tempo: readonly TempoPoint[], totalTicks: Tick): number {
  return steppedTempo(tempo.map((t) => ({ tick: t.tick, bpm: t.bpm }))).tickToSeconds(totalTicks);
}
