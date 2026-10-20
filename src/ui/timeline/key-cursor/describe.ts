/**
 * The sentences a screen reader says for a keyboard cursor: where it is (bar and beat), how long something is (1/4, 2 bars),
 * which note (C sharp 5). Pure text, so it is unit-tested and every editor says things the same way.
 */
import type { Tick, TimeSignature } from '@core/model/types';
import { keyName, TICKS_PER_STEP, ticksPerBar, ticksPerBeat } from '@core/time/ppq';

/** One whole note in ticks (four quarter notes): the unit note lengths such as "1/4" are fractions of. */
const WHOLE_NOTE_TICKS = 3840;
/** Fractions finer than 1/64 are said in steps or ticks instead. */
const FINEST_NOTE_FRACTION = 64;

/** "1 note", "3 notes". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Joins the parts of a sentence with commas, leaving out empty ones. */
export function joinParts(parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => !!part).join(', ');
}

/**
 * A key as a person says it: "C sharp 5". The app numbers octaves the way FL does (middle C is C5), the same as the key
 * labels on screen, so what is heard matches what is seen. The "#" is spelled out because readers say it as "number".
 */
export function spokenKeyName(key: number): string {
  return keyName(key).replace('#', ' sharp ');
}

/**
 * Where a tick is: "bar 2 beat 3", with "plus 2 steps" (1/16 notes) or "plus 40 ticks" when it is between beats.
 * Bars and beats count from 1.
 */
export function positionText(tick: Tick, timeSig: TimeSignature): string {
  const whole = Math.max(0, Math.round(tick));
  const barTicks = ticksPerBar(timeSig);
  const beatTicks = ticksPerBeat(timeSig);
  const bar = Math.floor(whole / barTicks);
  const inBar = whole - bar * barTicks;
  const beat = Math.floor(inBar / beatTicks);
  const rest = inBar - beat * beatTicks;
  const base = `bar ${bar + 1} beat ${beat + 1}`;
  if (rest === 0) return base;
  if (rest % TICKS_PER_STEP === 0) return `${base} plus ${plural(rest / TICKS_PER_STEP, 'step')}`;
  return `${base} plus ${plural(rest, 'tick')}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * How long something is: "2 bars" for whole bars, a note value such as "1/4" or "3/16" when the length is one, else
 * steps ("5 steps") or ticks.
 */
export function lengthText(length: Tick, timeSig: TimeSignature): string {
  const ticks = Math.max(0, Math.round(length));
  const barTicks = ticksPerBar(timeSig);
  if (ticks > 0 && ticks % barTicks === 0) return plural(ticks / barTicks, 'bar');
  const divisor = greatestCommonDivisor(ticks, WHOLE_NOTE_TICKS);
  const denominator = WHOLE_NOTE_TICKS / divisor;
  if (ticks > 0 && isPowerOfTwo(denominator) && denominator <= FINEST_NOTE_FRACTION) {
    return denominator === 1 ? '1 whole note' : `${ticks / divisor}/${denominator}`;
  }
  if (ticks > 0 && ticks % TICKS_PER_STEP === 0) return plural(ticks / TICKS_PER_STEP, 'step');
  return plural(ticks, 'tick');
}

/** A velocity (0 to 1) as the MIDI number people know, 1 to 127. */
export function velocityNumber(velocity: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity * 128)));
}
