/**
 * The pure math of leveling: which fader moves put the role buses at their style's levels, and what input the
 * master's Limiter gets to land on the style's loudness. No rendering, no project: numbers in, numbers out.
 */
import type { Style } from '@core/beat/style';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { LEVEL_TARGETS, LEVELED, offsetFromKick, type LeveledBus } from './targets';

/** Where the buses sum before the master chain (LUFS). */
export const PRE_LIMITER_LUFS = -16;
/** How far one leveling may move a fader down (dB). */
export const MOVE_MIN_DB = -12;
/** ... and up (dB). */
export const MOVE_MAX_DB = 6;
/** How far the shared trim may go either way (dB). */
const TRIM_LIMIT_DB = 24;
/**
 * The most input the Limiter gets: past about +10 dB it turns the whole mix down for every kick (pumping and squashing), and
 * the extra loudness a dB of input buys shrinks to a fraction of a dB. A louder master than that is shared with the Maximizer.
 */
export const LIMITER_INPUT_MAX_DB = 10;

/** The most input the Limiter gets for a style (the same for all: loudness past it comes from the Maximizer). */
export const limiterMax = (_style: Style): number => LIMITER_INPUT_MAX_DB;

/** A fader gain (linear) as dB; silence is −Infinity. */
export const gainToDb = (gain: number) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);
/** dB as a fader gain (linear). */
export const dbToGain = (db: number) => Math.pow(10, db / 20);
/** Limits `value` to the range `low`…`high`. */
export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** One role bus as measured. */
export interface BusLevel {
  role: LeveledBus;
  /** Integrated loudness of the bus as it is now (−Infinity: silent). */
  lufs: number;
  /** Its fader now (linear). */
  gain: number;
  /** A fader the AI set itself: it doesn't move. */
  pinned?: boolean;
}

/** One bus's fader move. */
export interface LevelMove {
  role: LeveledBus;
  from: number;
  /** The new fader (linear, at most +5.6 dB). */
  to: number;
  /** Its loudness after the move. */
  lufs: number;
  /** Where the style wants it (LUFS). */
  target: number;
}

/** All the moves, with the trim they share. */
export interface LevelPlan {
  moves: LevelMove[];
  /** The trim every bus got so they sum to −16 LUFS (dB). */
  trimDb: number;
  /** The buses' predicted sum (LUFS, adding their powers). */
  sumLufs: number;
}

/** The loudness of several sounds playing together (LUFS: their powers add). Silent ones count nothing. */
const powerSum = (lufs: readonly number[]) => {
  const power = lufs.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.pow(10, value / 10) : 0), 0);
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
};

/**
 * The fader moves that put every bus at its style's level relative to the kick (the first bus
 * present stands in when there is no kick), clamped to −12…+6 dB, then one trim for all of them so
 * they sum to −16 LUFS. Faders stop at +5.6 dB: then the trim stops there for all of them (the
 * balance comes first) and the Limiter's input makes up the rest (`limiterInput(style, sumLufs)`).
 * Pinned buses keep their fader and count in the sum as they are.
 */
export function levelMoves(buses: readonly BusLevel[], style: Style): LevelPlan {
  const styleTarget = LEVEL_TARGETS[style];
  const heard = buses.filter((bus) => Number.isFinite(bus.lufs) && bus.gain > 0);
  const reference = LEVELED.map((role) => heard.find((bus) => bus.role === role)).find((bus) => bus);
  if (!reference) return { moves: [], trimDb: 0, sumLufs: -Infinity };
  // Where the kick would be if it were as far from the reference bus as the style says.
  const kickLufs = reference.lufs - offsetFromKick(reference.role, styleTarget);
  const wanted = heard.map((bus) => {
    const target = kickLufs + offsetFromKick(bus.role, styleTarget);
    const move = bus.pinned ? 0 : clamp(target - bus.lufs, MOVE_MIN_DB, MOVE_MAX_DB);
    return { bus, target, move };
  });
  const trimDb = sharedTrim(wanted);
  const moves = wanted.map(({ bus, target, move }): LevelMove => {
    const to = bus.pinned ? bus.gain : Math.min(MAX_INSERT_VOLUME, bus.gain * dbToGain(move + trimDb));
    return { role: bus.role, from: bus.gain, to, lufs: bus.lufs + gainToDb(to) - gainToDb(bus.gain), target };
  });
  return { moves, trimDb, sumLufs: powerSum(moves.map((move) => move.lufs)) };
}

/**
 * The one trim (dB) every free bus gets after its own move, so the buses sum to the pre-Limiter level: the
 * pinned buses' power is taken off first, and no fader may be pushed past its maximum.
 */
function sharedTrim(wanted: readonly { bus: BusLevel; move: number }[]): number {
  const free = wanted.filter((entry) => !entry.bus.pinned);
  if (free.length === 0) return 0;
  const pinnedPower = wanted
    .filter((entry) => entry.bus.pinned)
    .reduce((sum, entry) => sum + Math.pow(10, entry.bus.lufs / 10), 0);
  const roomPower = Math.pow(10, PRE_LIMITER_LUFS / 10) - pinnedPower;
  const freeSumLufs = powerSum(free.map((entry) => entry.bus.lufs + entry.move));
  let trim =
    roomPower > 0 ? clamp(10 * Math.log10(roomPower) - freeSumLufs, -TRIM_LIMIT_DB, TRIM_LIMIT_DB) : -TRIM_LIMIT_DB;
  for (const entry of free) {
    const headroomDb = gainToDb(MAX_INSERT_VOLUME) - gainToDb(entry.bus.gain) - entry.move;
    trim = Math.min(trim, headroomDb);
  }
  return trim;
}

/**
 * The Limiter's input gain that brings the buses' sum (−16 LUFS, or what they reach) to the style's loudness, or to
 * `targetLufs` when the musician asked for one: 0…10 dB (what the Limiter can do cleanly; the Maximizer takes over beyond).
 */
export function limiterInput(style: Style, preLimiterLufs = PRE_LIMITER_LUFS, targetLufs?: number): number {
  return clamp((targetLufs ?? LEVEL_TARGETS[style].master) - preLimiterLufs, 0, limiterMax(style));
}
