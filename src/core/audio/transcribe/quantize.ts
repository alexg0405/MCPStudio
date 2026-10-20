/**
 * Quantizing heard times to the song's grid, with the swing choices. All times are pattern ticks (from the start of the
 * clip) as the song *plays* them; the quantizer returns the tick to write, so that the note plays where the quantizing said
 * once the song's own swing is applied.
 *
 * - `straighten`: a time moves towards the nearest straight grid line, as that line plays with the song's swing.
 * - `keep`: it moves towards the nearest line of the recording's own swung grid (`swingFound`), whatever the song's swing.
 *
 * Strength 1 puts the time on the line, 0 leaves it where it was heard. Pure.
 */
import { TICKS_PER_STEP } from '../../time/ppq';
import { swingAmount, swingTick, unswingTick } from '../../time/swing';
import type { QuantizeSettings } from './types';

/** Fewest off-beat sounds that tell a swing from chance. */
const MIN_OFFBEAT_SOUNDS = 4;
/** An off-beat sound counts for the swing when it is this close (ticks) to the 16th it sits on. */
const OFFBEAT_REACH = TICKS_PER_STEP * 0.45;

/** The median of a list (0 for none). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The swing (0..1) the sounds at these ticks were played with: how late the sounds on odd 16ths are against the sounds on
 * even ones, in units of half a step (full swing is a delay of 120 ticks). Null when too few sit on off-beat 16ths to say.
 */
export function measureSwing(ticks: readonly number[]): number | null {
  const even: number[] = [];
  const odd: number[] = [];
  for (const tick of ticks) {
    const step = Math.round(tick / TICKS_PER_STEP);
    const offset = tick - step * TICKS_PER_STEP;
    if (Math.abs(offset) > OFFBEAT_REACH) continue;
    (step % 2 === 0 ? even : odd).push(offset);
  }
  if (odd.length < MIN_OFFBEAT_SOUNDS || even.length < 1) return null;
  const delay = median(odd) - median(even);
  const swing = delay / (TICKS_PER_STEP / 2);
  return Math.max(0, Math.min(1, Math.round(swing * 100) / 100));
}

/** Turns a heard tick into the tick to write. */
export type Quantizer = (heardTick: number) => number;

/** What a quantizer needs besides the settings. */
export interface QuantizeContext {
  /** The song's swing (0..1). */
  songSwing: number;
  /** The recording's swing (`measureSwing`), for `keep`; null counts as straight. */
  swingFound: number | null;
  /** Ticks from song tick 0 to the clip's start: the grid is the song's, so an off-grid clip still lands on its lines. */
  clipStart: number;
}

/** The quantizer for some settings. With no grid it only undoes the song's swing so the note plays as heard. */
export function makeQuantizer(settings: QuantizeSettings, context: QuantizeContext): Quantizer {
  const grid = settings.gridTicks;
  const strength = Math.max(0, Math.min(1, settings.strength));
  if (grid <= 1 || strength === 0) return (tick) => Math.round(unswingTick(tick, context.songSwing));
  const keep = settings.swing === 'keep';
  const phase = keep ? 0 : ((context.clipStart % grid) + grid) % grid;
  const lineSwing = keep ? (context.swingFound ?? 0) : context.songSwing;
  return (tick) => {
    const target = nearestPlayedLine(tick, grid, phase, lineSwing);
    const moved = tick + (target - tick) * strength;
    return Math.round(unswingTick(moved, context.songSwing));
  };
}

/** The grid line nearest `tick`, as it plays with `swing`. */
function nearestPlayedLine(tick: number, grid: number, phase: number, swing: number): number {
  const base = Math.round((tick + phase) / grid);
  let best = Number.POSITIVE_INFINITY;
  let bestPlayed = tick;
  for (let k = base - 1; k <= base + 1; k++) {
    const line = k * grid - phase;
    const played = swingAmount(swing) > 0 ? swingTick(line, swing) : line;
    if (Math.abs(played - tick) < best) {
      best = Math.abs(played - tick);
      bestPlayed = played;
    }
  }
  return bestPlayed;
}
