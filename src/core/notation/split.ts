/**
 * Cuts a span of time into notes (or rests) that read easily. A span becomes one symbol when its length is one note value
 * and it does not run over a stronger place in the bar than the one it starts on; otherwise it is cut at the strongest
 * place inside it and each part is tried again. The pieces of a cut note are tied by the caller.
 *
 *  - A note starting on a beat may run over weaker places (a dotted half from beat 1) but not over the middle of a long
 *    bar or the next beat group. In simple meters a note starting on an eighth may run over one beat line (the
 *    "eighth, quarter, eighth" syncopation of pop music), no further.
 *  - A rest never runs over a place as strong as its own start: a half rest on beat 2 is two quarter rests.
 *
 * It works in any coordinate system: the bar's ticks, or the "written ticks" inside a triplet.
 */
import { greedyValues, ticksOfValue, valueOfTicks } from './durations';
import type { NoteValue } from './types';

/** What a span is cut by. */
export interface SplitRules {
  /** Strength of a place (0 strongest); see `meter.levelAt`. */
  levelOf(position: number): number;
  /** Smallest step between places a span may be cut at. */
  quantum: number;
  /** A rest follows a stricter rule than a note. */
  isRest: boolean;
  /** A note starting on a division may run over one beat line (simple meters only). */
  allowsBeatCrossing: boolean;
}

/** One piece of a split span. */
export interface Piece {
  from: number;
  to: number;
  value: NoteValue;
}

/** The weakest level a note starting at `startLevel` may still run over. */
function lowestAllowedLevel(startLevel: number, rules: SplitRules): number {
  if (startLevel <= 2) return startLevel;
  if (startLevel === 3 && !rules.allowsBeatCrossing) return 3;
  return startLevel - 1;
}

function runsOverStrongerPlace(from: number, to: number, rules: SplitRules): boolean {
  const startLevel = rules.levelOf(from);
  for (let position = from + rules.quantum; position < to; position += rules.quantum) {
    const level = rules.levelOf(position);
    if (rules.isRest ? level <= startLevel : level < lowestAllowedLevel(startLevel, rules)) return true;
  }
  return false;
}

/** The strongest place inside the span (the earliest of equals), or null when there is none. */
function strongestInside(from: number, to: number, rules: SplitRules): number | null {
  let best: number | null = null;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (let position = from + rules.quantum; position < to; position += rules.quantum) {
    const level = rules.levelOf(position);
    if (level < bestLevel) {
      best = position;
      bestLevel = level;
    }
  }
  return best;
}

/** Cuts [from, to) into pieces that each read as one note or rest. */
export function splitSpan(from: number, to: number, rules: SplitRules): Piece[] {
  if (to <= from) return [];
  const value = valueOfTicks(to - from);
  if (value && !runsOverStrongerPlace(from, to, rules)) return [{ from, to, value }];
  const cut = strongestInside(from, to, rules);
  if (cut === null) return greedyPieces(from, to);
  return [...splitSpan(from, cut, rules), ...splitSpan(cut, to, rules)];
}

/** A length with no place to cut at, written as the longest values in a row. */
function greedyPieces(from: number, to: number): Piece[] {
  const pieces: Piece[] = [];
  let at = from;
  for (const value of greedyValues(to - from)) {
    const ticks = ticksOfValue(value);
    pieces.push({ from: at, to: at + ticks, value });
    at += ticks;
  }
  return pieces;
}
