/**
 * Type guards and small helpers for reading project JSON that has not been checked yet. Repair never
 * trusts a value's type: everything it reads goes through one of these.
 */

/** A JSON object whose contents are not yet known to match the project types. */
export type JsonObject = Record<string, unknown>;

/** True for a plain JSON object (not null, not an array). */
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when `key` is the object's own property (never one inherited from the prototype). */
export const hasOwn = (object: JsonObject, key: string): boolean => Object.hasOwn(object, key);

/** True when the object has `key` and its value is not `undefined` (an optional field that is set). */
export const isSet = (object: JsonObject, key: string): boolean => hasOwn(object, key) && object[key] !== undefined;

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** A non-empty string, which is what every record id must be. */
export const isId = (value: unknown): value is string => isString(value) && value !== '';

/** True for an integer from `min` to `max`, both included. */
export const isIntegerBetween = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** True for a whole number of 1 or more. */
export const isPositiveInteger = (value: unknown): value is number => isIntegerBetween(value, 1, Infinity);

/** True for a finite number that is zero or more. */
export const isNonNegativeNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

/** `value` limited to `min`…`max`. */
export const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
