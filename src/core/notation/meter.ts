/**
 * How a time signature divides a bar: the beat groups notes are beamed in, which places in the bar are strong, and
 * where a triplet may start. Everything that splits notes and rests, and everything that beams, asks this module.
 */
import type { Tick, TimeSignature } from '../model/types';
import { ticksPerBar, ticksPerBeat } from '../time/ppq';

/** The metrical structure of one bar. */
export interface Meter {
  barTicks: Tick;
  /** Start of every beat group, then the end of the bar. For 4/4: 0, 960, 1920, 2880, 3840. */
  groupEdges: Tick[];
  /** The half-bar tick when the bar has four or more groups in an even number (4/4, 12/8), else -1. */
  halfTick: Tick;
  /** The next level of division inside a group (an eighth in 4/4 and 6/8). */
  divisionTicks: Tick;
  /** Length of the window a triplet fills (a beat in 4/4, an eighth in 6/8). */
  tripletWindowTicks: Tick;
}

/** Longest triplet window: a quarter note. A beat of a half note (2/2) still takes quarter-note triplets at most. */
const MAX_TRIPLET_WINDOW = 960;
/** Levels past the division halve the division until this many ticks (a 128th is never reached). */
const MAX_LEVEL = 9;

/** How many units (beats, or eighths in a compound meter) each group of a bar holds. */
function groupSizes(timeSig: TimeSignature): number[] {
  const { num, den } = timeSig;
  const isCompound = den >= 8 && num % 3 === 0;
  if (isCompound) return new Array<number>(num / 3).fill(3);
  if (num === 5) return [3, 2];
  if (num === 7) return [2, 2, 3];
  if (den >= 8) {
    // Eighths in pairs; an odd leftover is a group of three at the end.
    const sizes: number[] = [];
    let left = num;
    while (left > 0) {
      const size = left === 3 ? 3 : Math.min(2, left);
      sizes.push(size);
      left -= size;
    }
    return sizes;
  }
  return new Array<number>(num).fill(1);
}

/** The structure of a bar in this time signature. */
export function meterOf(timeSig: TimeSignature): Meter {
  const unit = ticksPerBeat(timeSig);
  const sizes = groupSizes(timeSig);
  const groupEdges: Tick[] = [0];
  for (const size of sizes) groupEdges.push((groupEdges[groupEdges.length - 1] as number) + size * unit);
  const isEven = sizes.length >= 4 && sizes.length % 2 === 0;
  const halfTick = isEven ? (groupEdges[sizes.length / 2] as number) : -1;
  const isSimple = timeSig.den <= 4;
  return {
    barTicks: ticksPerBar(timeSig),
    groupEdges,
    halfTick,
    divisionTicks: isSimple ? unit / 2 : unit,
    tripletWindowTicks: isSimple ? Math.min(unit, MAX_TRIPLET_WINDOW) : unit,
  };
}

/**
 * How strong a place in the bar is: 0 the bar line, 1 the middle of a long bar, 2 a beat group, 3 a division of the
 * group (an eighth in 4/4), then 4, 5... for each halving. A smaller number is stronger. Notes may not run over a
 * place stronger than the one they start on (see `split.ts`).
 */
export function levelAt(meter: Meter, tickInBar: Tick): number {
  if (tickInBar % meter.barTicks === 0) return 0;
  if (tickInBar === meter.halfTick) return 1;
  if (meter.groupEdges.includes(tickInBar)) return 2;
  let division = meter.divisionTicks;
  for (let level = 3; level <= MAX_LEVEL; level++) {
    if (tickInBar % division === 0) return level;
    division /= 2;
    if (division < 1) break;
  }
  return MAX_LEVEL;
}

/** The index of the beat group a tick in the bar falls in. */
export function groupIndexAt(meter: Meter, tickInBar: Tick): number {
  for (let i = meter.groupEdges.length - 2; i >= 0; i--) if (tickInBar >= (meter.groupEdges[i] as number)) return i;
  return 0;
}
