/** Repair of variant patterns (`Pattern.derived`): patterns made from another pattern by a list of steps. */
import { VARIANT_KINDS, type VariantKind } from '../../model/types';
import { type RepairLog, countOf, noun } from './log';
import { hasOwn, isFiniteNumber, isObject, isSet, isString, type JsonObject } from '../json-values';

const isVariantStep = (value: unknown): boolean =>
  isObject(value) &&
  VARIANT_KINDS.includes(value.kind as VariantKind) &&
  isFiniteNumber(value.from) &&
  isFiniteNumber(value.to) &&
  value.from >= 0 &&
  value.to > value.from &&
  (value.parts === undefined || (Array.isArray(value.parts) && value.parts.every(isString)));

const countMadeOrdinary = (log: RepairLog) =>
  log.count(
    'derived',
    (n) => `Made ${countOf(n, noun('variant pattern'))} ordinary patterns (what they varied is gone or damaged).`,
  );

/**
 * Variants must point at another pattern that exists, without a loop, and hold well-formed steps;
 * otherwise they become ordinary patterns (their notes stay).
 */
export function repairVariants(patterns: JsonObject, log: RepairLog): void {
  for (const entry of Object.values(patterns)) {
    const pattern = entry as JsonObject;
    if (!isSet(pattern, 'derived') || isValidVariant(pattern, patterns)) continue;
    delete pattern.derived;
    countMadeOrdinary(log);
  }
  // A loop of variants (A varies B varies A) has no source: the pattern that closes it lets go.
  for (const entry of Object.values(patterns)) {
    const pattern = entry as JsonObject;
    if (!closesVariantLoop(pattern, patterns)) continue;
    delete pattern.derived;
    countMadeOrdinary(log);
  }
  log.flush();
}

/** True when `pattern.derived` names another existing pattern, well-formed steps, a seed and a hash. */
function isValidVariant(pattern: JsonObject, patterns: JsonObject): boolean {
  const derived = pattern.derived;
  return (
    isObject(derived) &&
    isString(derived.from) &&
    derived.from !== pattern.id &&
    hasOwn(patterns, derived.from) &&
    Array.isArray(derived.steps) &&
    derived.steps.every(isVariantStep) &&
    isFiniteNumber(derived.seed) &&
    isString(derived.hash)
  );
}

/** True when following "varies" links from `pattern` leads back to `pattern` itself. */
function closesVariantLoop(pattern: JsonObject, patterns: JsonObject): boolean {
  const visited = new Set<string>([pattern.id as string]);
  let next = sourceIdOf(pattern);
  while (next && !visited.has(next)) {
    visited.add(next);
    const source = patterns[next] as JsonObject | undefined;
    next = source ? sourceIdOf(source) : undefined;
  }
  return Boolean(next) && next === pattern.id;
}

/** The id of the pattern this one varies, when it is a variant. */
const sourceIdOf = (pattern: JsonObject): string | undefined =>
  isObject(pattern.derived) ? (pattern.derived.from as string) : undefined;
