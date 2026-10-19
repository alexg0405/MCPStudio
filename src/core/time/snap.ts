import type { Tick, TimeSignature } from '../model/types';
import { TICKS_PER_STEP, ticksPerBar, ticksPerBeat } from './ppq';

/**
 * Snap grids, named after FL's: bars, beats, steps (1/16) and fractions, including triplets.
 * 'auto' follows the zoom level (the grid the user can see).
 */
export type Snap =
  'auto' | 'none' | 'bar' | 'beat' | 'beat/2' | 'beat/3' | 'step' | 'beat/6' | 'step/2' | 'step/3' | 'step/4';

/** The snap choices with their labels, in the order a menu lists them: Main (auto), none, then finest to coarsest. */
export const SNAP_OPTIONS: { value: Snap; label: string }[] = [
  { value: 'auto', label: 'Main (auto)' },
  { value: 'none', label: '(none)' },
  { value: 'step/4', label: '1/4 step' },
  { value: 'step/3', label: '1/3 step' },
  { value: 'step/2', label: '1/2 step' },
  { value: 'beat/6', label: '1/6 beat' },
  { value: 'step', label: 'Step' },
  { value: 'beat/3', label: '1/3 beat' },
  { value: 'beat/2', label: '1/2 beat' },
  { value: 'beat', label: 'Beat' },
  { value: 'bar', label: 'Bar' },
];

/** Smallest on-screen grid cell (px) that 'auto' will snap to. */
const AUTO_MIN_PX = 10;

/** Grid size in ticks. `pxPerTick` is only needed for 'auto'. */
export function gridTicks(snap: Snap, ts: TimeSignature, pxPerTick = 0.1): Tick {
  const beat = ticksPerBeat(ts);
  switch (snap) {
    case 'none':
      return 1;
    case 'bar':
      return ticksPerBar(ts);
    case 'beat':
      return beat;
    case 'beat/2':
      return beat / 2;
    case 'beat/3':
      return beat / 3;
    case 'beat/6':
      return beat / 6;
    case 'step':
      return TICKS_PER_STEP;
    case 'step/2':
      return TICKS_PER_STEP / 2;
    case 'step/3':
      return TICKS_PER_STEP / 3;
    case 'step/4':
      return TICKS_PER_STEP / 4;
    case 'auto': {
      for (const t of [TICKS_PER_STEP / 4, TICKS_PER_STEP / 2, TICKS_PER_STEP, beat, ticksPerBar(ts)]) {
        if (t * pxPerTick >= AUTO_MIN_PX) return t;
      }
      return ticksPerBar(ts);
    }
  }
}

/**
 * A tick moved to the nearest line of a grid of `grid` ticks (a grid of 1 tick or less just rounds to a whole tick).
 */
export function snapRound(tick: number, grid: Tick): Tick {
  return grid <= 1 ? Math.round(tick) : Math.round(tick / grid) * grid;
}

/**
 * A tick moved back to the line of a grid of `grid` ticks at or before it (a grid of 1 tick or less just rounds down to
 * a whole tick).
 */
export function snapFloor(tick: number, grid: Tick): Tick {
  return grid <= 1 ? Math.floor(tick) : Math.floor(tick / grid) * grid;
}

/** Grid lines worth drawing at this zoom: the finest level whose spacing is at least `minPx`. */
export function visibleGrid(ts: TimeSignature, pxPerTick: number, minPx = 6): { step: Tick; beat: Tick; bar: Tick } {
  const bar = ticksPerBar(ts);
  const beat = ticksPerBeat(ts);
  const pick = (t: Tick) => (t * pxPerTick >= minPx ? t : 0);
  return { step: pick(TICKS_PER_STEP), beat: pick(beat), bar: bar * pxPerTick >= 2 ? bar : bar * 4 };
}
