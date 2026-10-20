/**
 * The arithmetic of a keyboard cursor on a timeline: stepping along the grid, jumping by bars, and scrolling the view
 * just far enough to show the cursor. Pure functions of numbers and the `Viewport`, so they are unit-tested.
 */
import type { Tick } from '@core/model/types';
import { clamp, type Viewport } from '../viewport';

/** How far (px) the cursor stays from the view's edge when the view has to scroll to show it. */
export const REVEAL_MARGIN_PX = 24;

/**
 * The grid line one step before or after `tick`: a tick between lines goes to the line in that direction, one on a line
 * goes to the next. A grid of 1 tick or less (snap off) moves by whole ticks. Never below 0 or above `maxTick`.
 */
export function stepTick(tick: Tick, direction: -1 | 1, step: Tick, maxTick: Tick): Tick {
  const size = Math.max(1, step);
  const next = direction > 0 ? (Math.floor(tick / size) + 1) * size : (Math.ceil(tick / size) - 1) * size;
  return clamp(next, 0, Math.max(0, maxTick));
}

/** The start of the bar before or after `tick` (a tick inside a bar goes to that bar's start when moving back). */
export function barTick(tick: Tick, direction: -1 | 1, barTicks: Tick, maxTick: Tick): Tick {
  return stepTick(tick, direction, barTicks, maxTick);
}

/** The cursor's tick put back on the grid (when the grid changed under it), within the song. */
export function snapCursorTick(tick: Tick, step: Tick, maxTick: Tick): Tick {
  const size = Math.max(1, step);
  return clamp(Math.floor(tick / size) * size, 0, Math.max(0, maxTick));
}

/**
 * Scrolls the view sideways, in one jump, so the ticks from `from` to `to` are on screen (the start wins when the span is
 * wider than the view). Returns true when the view moved. `maxScrollTick` is how far the song scrolls.
 */
export function revealTicks(vp: Viewport, from: Tick, to: Tick, maxScrollTick: Tick): boolean {
  if (vp.width <= 1 || vp.pxPerTick <= 0) return false;
  const margin = REVEAL_MARGIN_PX / vp.pxPerTick;
  const visible = vp.width / vp.pxPerTick;
  const left = vp.scrollTick;
  let target = left;
  if (to + margin > left + visible) target = to + margin - visible;
  if (from - margin < target) target = from - margin;
  target = clamp(target, 0, Math.max(0, maxScrollTick - visible));
  if (target === left) return false;
  vp.scrollTick = target;
  return true;
}

/** Scrolls the view up or down, in one jump, so row `row` (and a little around it) is on screen. Returns true when it moved. */
export function revealRow(vp: Viewport, row: number): boolean {
  if (vp.height <= 1 || vp.rowHeight <= 0) return false;
  const visibleRows = vp.height / vp.rowHeight;
  const marginRows = Math.min(1, visibleRows / 4);
  const top = vp.scrollRow;
  let target = top;
  if (row + 1 + marginRows > top + visibleRows) target = row + 1 + marginRows - visibleRows;
  if (row - marginRows < target) target = row - marginRows;
  target = clamp(target, 0, Math.max(0, vp.rows - visibleRows));
  if (target === top) return false;
  vp.scrollRow = target;
  return true;
}
