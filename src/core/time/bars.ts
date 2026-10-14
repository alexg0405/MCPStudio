/** Bar numbers as musicians say them: 1-based, ranges inclusive ("bars 17–32" is 16 bars). */
import type { Tick, TimeSignature } from '../model/types';
import { ticksPerBar } from './ppq';

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A song position as a 1-based bar number (fractions inside the bar: 17.5 = halfway through bar 17). */
export function barOf(tick: Tick, ts: TimeSignature): number {
  return r2(tick / ticksPerBar(ts) + 1);
}

/** "bar 9", "bars 17–32" (whole bars, inclusive), or "bar 17.25 to 20.5" (positions) off the bar lines. */
export function barSpan(from: Tick, to: Tick, ts: TimeSignature): string {
  const bar = ticksPerBar(ts);
  const a = from / bar;
  const b = to / bar;
  if (Number.isInteger(a) && Number.isInteger(b) && b > a) return b - a === 1 ? `bar ${a + 1}` : `bars ${a + 1}–${b}`;
  return `bar ${r2(a + 1)} to ${r2(b + 1)}`;
}
