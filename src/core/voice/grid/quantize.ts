import type { VoiceEvent, VoiceKind } from '../analyze';

export interface Grid {
  bpm: number;
  /** Where bar 1 beat 1 is in the audio (seconds). */
  startSec: number;
  /** Events at or beyond this many bars are dropped (default: no limit). */
  bars?: number;
  /** Default 4. */
  beatsPerBar?: number;
  /** Default 4 (1/16 steps). */
  stepsPerBeat?: number;
}

export interface GridEvent extends VoiceEvent {
  /** Steps from bar 1 beat 1; a multiple of `resolution`. */
  step: number;
  /** Length in steps, a multiple of `resolution` and at least one resolution unit. */
  lengthSteps: number;
  /** Timing deviation from the grid position before quantizing (ms, positive = late). */
  offsetMs: number;
}

export interface QuantizeOptions {
  /** Grid unit in steps: 1 (default) or 0.5 (1/32 at 1/16 steps, for hat rolls). */
  resolution?: 0.5 | 1;
  /**
   * 0..1, the project's swing: the grid's odd steps sit later by swing × half a step (as the
   * engine plays them), so a swung performance quantizes onto the steps it meant.
   */
  swing?: number;
}

/** The order events of different kinds share a step in. */
export const KIND_ORDER: Record<VoiceKind, number> = { kick: 0, snare: 1, hat: 2, tonal: 3 };

/** An event this many steps (or more) before bar 1 is dropped instead of snapped to it. */
const EARLIEST_STEP = -0.5;
/** Two grid positions are equally near when their distances differ by less than this (steps). */
const TIE_EPSILON = 1e-9;

/** Where positions on the grid are played, and which one is nearest a time. */
class GridSnapper {
  constructor(
    private readonly resolution: number,
    private readonly swing: number,
  ) {}

  /** Where grid position g (in steps) is played: odd whole steps are pushed late by the swing. */
  played(g: number): number {
    return Number.isInteger(g) && Math.abs(g % 2) === 1 ? g + this.swing / 2 : g;
  }

  /** Nearest grid position to x (steps); ties go to the earlier one. */
  nearest(x: number): number {
    const r = this.resolution;
    let best = Math.floor(x / r) * r - r;
    let bestDist = Infinity;
    for (let g = best; g <= x + 2 * r; g += r) {
      const d = Math.abs(x - this.played(g));
      if (d < bestDist - TIE_EPSILON) {
        bestDist = d;
        best = g;
      }
    }
    return best;
  }
}

/**
 * Quantizes events to the grid. Events more than half a step before bar 1 are dropped, as are
 * events at or after `grid.bars`. Two events of the same kind on the same step resolve to one:
 * drums keep the stronger, tonal events merge into one note (the longer one's pitch, spanning
 * both). Different kinds may share a step (a kick and a hat). Sorted by step, then kind.
 */
export function quantizeToGrid(events: readonly VoiceEvent[], grid: Grid, opts: QuantizeOptions = {}): GridEvent[] {
  if (!(grid.bpm > 0) || !Number.isFinite(grid.bpm)) throw new RangeError(`quantizeToGrid: invalid bpm ${grid.bpm}.`);
  const stepsPerBeat = Math.max(1, grid.stepsPerBeat ?? 4);
  const stepSec = 60 / grid.bpm / stepsPerBeat;
  const resolution = opts.resolution === 0.5 ? 0.5 : 1;
  const swing = Math.min(1, Math.max(0, opts.swing ?? 0));
  const total = grid.bars === undefined ? Infinity : grid.bars * Math.max(1, grid.beatsPerBar ?? 4) * stepsPerBeat;
  const snapper = new GridSnapper(resolution, swing);

  const snapped: GridEvent[] = [];
  for (const e of events) {
    const x = (e.time - grid.startSec) / stepSec;
    if (!Number.isFinite(x) || x < EARLIEST_STEP) continue;
    const step = Math.max(0, snapper.nearest(x));
    if (step >= total) continue;
    const endStep = snapper.nearest((e.time + Math.max(0, e.duration) - grid.startSec) / stepSec);
    snapped.push({
      ...e,
      step,
      lengthSteps: Math.max(resolution, Math.min(total, endStep) - step),
      offsetMs: (x - snapper.played(step)) * stepSec * 1000,
    });
  }
  snapped.sort((a, b) => a.step - b.step || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.time - b.time);
  return mergeSameStep(snapped);
}

/** Same kind on the same step: keep the stronger drum, merge tonal notes. */
function mergeSameStep(events: readonly GridEvent[]): GridEvent[] {
  const resolved: GridEvent[] = [];
  for (const e of events) {
    const i = resolved.findIndex((o) => o.step === e.step && o.kind === e.kind);
    const prev = resolved[i];
    if (!prev) {
      resolved.push(e);
      continue;
    }
    if (e.kind !== 'tonal') {
      if (e.strength > prev.strength) resolved[i] = e;
      continue;
    }
    resolved[i] = mergeTonal(prev, e);
  }
  return resolved;
}

/** Two tonal events on one step as one note: the longer one's pitch, spanning both. */
function mergeTonal(a: GridEvent, b: GridEvent): GridEvent {
  const [first, second] = a.time <= b.time ? [a, b] : [b, a];
  const main = second.duration > first.duration ? second : first;
  const endSec = Math.max(first.time + first.duration, second.time + second.duration);
  return {
    ...main,
    time: first.time,
    duration: endSec - first.time,
    strength: Math.max(first.strength, second.strength),
    confidence: Math.max(first.confidence, second.confidence),
    pitchEnd: second.pitchEnd ?? main.pitchEnd,
    step: first.step,
    lengthSteps: Math.max(first.step + first.lengthSteps, second.step + second.lengthSteps) - first.step,
    offsetMs: first.offsetMs,
  };
}
