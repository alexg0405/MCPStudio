/**
 * Swing as a smooth curve inside each 1/8 note. The second 1/16 of every 8th plays late by
 * swing × half a step (as it always did), and every position in between moves along a straight
 * line on each side of it: the first 1/16 of the 8th is stretched, the second one squeezed. So a
 * note just before or after the odd 1/16 (humanized, recorded, nudged) and a 1/32 roll keep their
 * place in the groove instead of falling back onto the straight grid.
 *
 * Applied to a note's position within its pattern (like FL's channel swing), by the scheduler and
 * everything that reads the song the way it plays (MIDI export).
 */
import { TICKS_PER_STEP } from './ppq';

const HALF = TICKS_PER_STEP;
const EIGHTH = 2 * TICKS_PER_STEP;

/** The delay of a note exactly on an odd 1/16, in ticks: swing (0..1) × half a step. */
export function swingAmount(swing: number): number {
  return swing > 0 ? Math.min(1, swing) * (TICKS_PER_STEP / 2) : 0;
}

/**
 * How much later than written a note at `tick` (its position in the pattern) plays, in ticks.
 * 0 on every 1/8 line, the full `swingAmount` on the odd 1/16s, linear in between.
 */
export function swingDelay(tick: number, swing: number): number {
  const s = swingAmount(swing);
  if (s === 0) return 0;
  const pos = ((tick % EIGHTH) + EIGHTH) % EIGHTH;
  // Written as s × (a ratio) so that a note exactly on the odd 1/16 moves by exactly s.
  return pos < HALF ? s * (pos / HALF) : s * ((EIGHTH - pos) / HALF);
}

/** Where a note written at `tick` plays with `swing`: first half of each 8th pos × (240 + s) / 240,
 * second half 240 + s + (pos − 240) × (240 − s) / 240 (s = swing × 120 ticks). */
export function swingTick(tick: number, swing: number): number {
  return tick + swingDelay(tick, swing);
}
