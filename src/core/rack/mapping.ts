/**
 * The maths of a macro: how its knob position (0–1) becomes a value of a parameter, a mix, a branch level, a
 * crossover or the rack's gain. Pure and shared by the engine (which applies it to audio) and the editor (which shows
 * it), so what is drawn is what is heard.
 *
 * Everything works in the target's own knob travel: a frequency or a level is swept the way its knob would be turned,
 * so a macro over 200 Hz … 8 kHz moves evenly in octaves.
 */
import {
  decode,
  encode,
  fromNormalized,
  p,
  toNormalized,
  type FloatSpec,
  type ParamSpec,
} from '@agstudio/sdk/params';
import {
  BRANCH_LEVEL_MAX_DB,
  BRANCH_LEVEL_MIN_DB,
  CROSSOVER_MAX_HZ,
  CROSSOVER_MIN_HZ,
  RACK_PARAMS,
} from '../model/rack';
import type { MacroCurve, MacroMapping, MacroTarget } from '../model/types';

/** A branch's level, in dB. */
export const BRANCH_LEVEL_SPEC: FloatSpec = p.float(BRANCH_LEVEL_MIN_DB, BRANCH_LEVEL_MAX_DB, 0, { unit: 'dB', scale: 'db' });
/** A branch's pan, −1 … 1. */
export const BRANCH_PAN_SPEC: FloatSpec = p.float(-1, 1, 0);
/** An effect's dry/wet, 0 … 1. */
export const MIX_SPEC: FloatSpec = p.float(0, 1, 1, { unit: '%' });
/** One crossover frequency, in Hz (a log knob). */
export const CROSSOVER_SPEC: FloatSpec = p.float(CROSSOVER_MIN_HZ, CROSSOVER_MAX_HZ, 500, { unit: 'Hz', scale: 'log' });
/** The rack's output gain, in dB. */
export const RACK_GAIN_SPEC = RACK_PARAMS.gain as FloatSpec;

/** How far the exponential curve bends: the knob position raised to this power. */
const EXPONENTIAL_POWER = 2;

/** The knob position (0–1) a macro value and a curve lead to, before the range is applied. */
export function curvePosition(curve: MacroCurve, macro: number): number {
  const m = Number.isFinite(macro) ? Math.min(1, Math.max(0, macro)) : 0;
  switch (curve) {
    case 'linear':
      return m;
    case 'exponential':
      return Math.pow(m, EXPONENTIAL_POWER);
    case 'inverted':
      return 1 - m;
  }
}

/** The parameter spec of a target that is not a parameter of an effect (those come from the effect's plugin). */
export function builtInTargetSpec(target: MacroTarget): ParamSpec | null {
  switch (target.kind) {
    case 'mix':
      return MIX_SPEC;
    case 'branch':
      return target.param === 'level' ? BRANCH_LEVEL_SPEC : BRANCH_PAN_SPEC;
    case 'crossover':
      return CROSSOVER_SPEC;
    case 'gain':
      return RACK_GAIN_SPEC;
    case 'param':
      return null;
  }
}

/** A number as the target's knob travel (0–1): an enum is its option number, a switch is 0 or 1. */
function travelOf(spec: ParamSpec, encoded: number): number {
  return toNormalized(spec, decode(spec, encoded));
}

/**
 * The target's value (numeric encoding: an enum is its option number, a switch 0 or 1) with the macro at `macro` (0–1).
 * The range may run backwards (`min` above `max`); `inverted` runs it backwards again.
 */
export function macroTargetValue(
  spec: ParamSpec,
  mapping: Pick<MacroMapping, 'min' | 'max' | 'curve'>,
  macro: number,
): number {
  const position = curvePosition(mapping.curve, macro);
  const from = travelOf(spec, mapping.min);
  const to = travelOf(spec, mapping.max);
  return encode(spec, fromNormalized(spec, from + (to - from) * position));
}

/**
 * Whether the target does not follow the macro in a straight line between two scheduled points, so the engine splits a
 * long ramp into pieces: a bent curve, a log knob or a stepped (int, enum, switch) parameter.
 */
export function isBentMapping(spec: ParamSpec, curve: MacroCurve): boolean {
  if (curve === 'exponential') return true;
  if (spec.type !== 'float') return true;
  return spec.scale === 'log';
}

/**
 * The range a new mapping starts with: it begins at the target's value now (so the sound does not jump when the macro
 * is at 0) and sweeps to whichever end of the target's range is further away, so the macro has room to move it.
 */
export function startingRange(spec: ParamSpec, current: number): { min: number; max: number } {
  if (spec.type === 'bool') return { min: current >= 0.5 ? 1 : 0, max: current >= 0.5 ? 0 : 1 };
  const low = encode(spec, fromNormalized(spec, 0));
  const high = encode(spec, fromNormalized(spec, 1));
  const atHigh = Math.abs(current - high) < Math.abs(current - low);
  return atHigh ? { min: current, max: low } : { min: current, max: high };
}
