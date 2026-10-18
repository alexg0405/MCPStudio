/**
 * Single-field fixes shared by every repair step. Each one changes the object in place and says
 * whether it had to, so a step can count "this record was damaged" once however many fields were bad.
 */
import { isFiniteNumber, isSet, type JsonObject } from '../json-values';

/** Limits a numeric field to `min`…`max`; a value that is not a number becomes `fallback`. True when it changed. */
export function clampField(object: JsonObject, key: string, min: number, max: number, fallback: number): boolean {
  const value = object[key];
  const next = isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return storeIfChanged(object, key, next);
}

/** As `clampField`, and the result is rounded to a whole number. */
export function clampIntegerField(
  object: JsonObject,
  key: string,
  min: number,
  max: number,
  fallback: number,
): boolean {
  const value = object[key];
  const clamped = isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return storeIfChanged(object, key, Math.round(clamped));
}

function storeIfChanged(object: JsonObject, key: string, next: number): boolean {
  if (Object.is(next, object[key])) return false;
  object[key] = next;
  return true;
}

/** Replaces a required field of the wrong type with `fallback`. True when it did. */
export function requireField(
  object: JsonObject,
  key: string,
  isValid: (value: unknown) => boolean,
  fallback: unknown,
): boolean {
  if (isValid(object[key])) return false;
  object[key] = fallback;
  return true;
}

/** Deletes an optional field that is present with the wrong type. True when it did. */
export function dropInvalidField(object: JsonObject, key: string, isValid: (value: unknown) => boolean): boolean {
  if (!isSet(object, key) || isValid(object[key])) return false;
  delete object[key];
  return true;
}

/**
 * Fixes several fields of one object and remembers whether any of them needed it. This replaces a
 * chain of `fixed = fixField() || fixed` lines (the fix must always run, so `||` has to go second).
 */
export class FieldRepairs {
  /** True once any fix below changed the object. */
  changed = false;

  constructor(private readonly object: JsonObject) {}

  /** Records a fix made elsewhere (for example a field that was deleted by hand). */
  noteChange(didChange: boolean): void {
    if (didChange) this.changed = true;
  }

  /** `clampField` on a required numeric field. */
  clamp(key: string, min: number, max: number, fallback: number): void {
    this.noteChange(clampField(this.object, key, min, max, fallback));
  }

  /** `clampIntegerField` on a required numeric field. */
  clampInteger(key: string, min: number, max: number, fallback: number): void {
    this.noteChange(clampIntegerField(this.object, key, min, max, fallback));
  }

  /** `clampField` on an optional numeric field: nothing happens while the field is absent. */
  clampIfSet(key: string, min: number, max: number, fallback: number): void {
    if (isSet(this.object, key)) this.clamp(key, min, max, fallback);
  }

  /** `requireField`. */
  require(key: string, isValid: (value: unknown) => boolean, fallback: unknown): void {
    this.noteChange(requireField(this.object, key, isValid, fallback));
  }

  /** `dropInvalidField`. */
  dropIfInvalid(key: string, isValid: (value: unknown) => boolean): void {
    this.noteChange(dropInvalidField(this.object, key, isValid));
  }
}
