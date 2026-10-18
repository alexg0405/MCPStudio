/**
 * The deck automation of one transition: equal-power volume curves, the bass swap, the filter sweep and the echo throw,
 * as points relative to each curve's start.
 */
import type { Tick } from '../model/types';
import { TICKS_PER_BEAT } from './plan-layout';
import type { Deck, DeckControl, DjAutomation, DjPurpose, TransitionRecipe } from './plan-types';

/** Lows cut to here take a song's bass and kick out (EQ Pro band 1, 24 dB/oct). */
export const BASS_CUT_HZ = 300;
/** Where the filter sweep out of a song ends. */
export const FILTER_OUT_HZ = 350;

/** Equal-power curves are drawn in this many straight pieces. */
const POWER_CURVE_PIECES = 8;

/** A curve point: where (ticks) and what value (see `DjAutomation`). */
type CurvePoint = { at: Tick; value: number | 'neutral' };

/** Equal-power curve points over [from, to) of a window: sin for in, cos for out (8 pieces). */
function powerCurve(from: Tick, to: Tick, direction: 'in' | 'out'): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let k = 0; k <= POWER_CURVE_PIECES; k++) {
    const t = k / POWER_CURVE_PIECES;
    const gain = direction === 'in' ? Math.sin((Math.PI / 2) * t) : Math.cos((Math.PI / 2) * t);
    points.push({ at: Math.round(from + (to - from) * t), value: Math.round(gain * 1e6) / 1e6 });
  }
  if (direction === 'in') points[points.length - 1]!.value = 'neutral';
  return points;
}

/**
 * The curves of one transition, points relative to each item's start. `start` is where the incoming song comes in,
 * `overlap` how long both play, `swap` where the bass changes hands.
 */
export function transitionCurves(
  transition: number,
  recipe: TransitionRecipe,
  outgoing: Deck,
  incoming: Deck,
  start: Tick,
  overlap: Tick,
  swap: Tick,
): DjAutomation[] {
  const items: DjAutomation[] = [];
  const add = (deck: Deck, control: DeckControl, purpose: DjPurpose, from: Tick, to: Tick, points: CurvePoint[]) =>
    items.push({
      transition,
      deck,
      control,
      purpose,
      start: from,
      length: Math.max(1, to - from),
      points: points.map((p) => ({ at: p.at - from, value: p.value })),
    });
  /** The outgoing song's last beat goes into the echo send, which is let go again right after. */
  const throwBeat = (end: Tick) =>
    add(outgoing, 'echo', 'echo-out', end - TICKS_PER_BEAT, end, [
      { at: end - TICKS_PER_BEAT, value: 1 },
      { at: end, value: 1 },
      { at: end, value: 'neutral' },
    ]);
  if (recipe === 'cut') {
    if (start - TICKS_PER_BEAT >= 0) throwBeat(start);
    return items;
  }
  const end = start + overlap;
  // The incoming song: in on an equal-power curve with its lows cut until the swap.
  const fadeInEnd = recipe === 'echo' ? swap : end;
  add(incoming, 'volume', 'fade-in', start, fadeInEnd, powerCurve(start, fadeInEnd, 'in'));
  add(incoming, 'low-cut', 'bass-in', start, swap, [
    { at: start, value: BASS_CUT_HZ },
    { at: swap, value: BASS_CUT_HZ },
    { at: swap, value: 'neutral' },
  ]);
  if (recipe === 'echo') {
    // The outgoing song plays on with its bass and stops on the swap with an echo.
    throwBeat(swap);
    return items;
  }
  // The outgoing song: out on an equal-power curve; its lows go at the swap.
  add(outgoing, 'volume', 'fade-out', start, end, [...powerCurve(start, end, 'out'), { at: end, value: 'neutral' }]);
  add(outgoing, 'low-cut', 'bass-out', swap, end, [
    { at: swap, value: 'neutral' },
    { at: swap, value: BASS_CUT_HZ },
    { at: end, value: BASS_CUT_HZ },
    { at: end, value: 'neutral' },
  ]);
  if (recipe === 'filter') {
    add(outgoing, 'filter', 'filter-out', swap, end, [
      { at: swap, value: 'neutral' },
      { at: end, value: FILTER_OUT_HZ },
      { at: end, value: 'neutral' },
    ]);
  }
  return items;
}
