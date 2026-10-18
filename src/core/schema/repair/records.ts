/**
 * Records are objects stored under their own id (`channels`, `patterns`, ...) next to an order array that
 * lists the ids. These two steps make a table of records, and its order array, well formed.
 */
import { type RepairLog, countOf, noun, withPrefix, type Noun } from './log';
import { hasOwn, isObject, isString, type JsonObject } from '../json-values';

/**
 * Drops entries that are not objects (or have an unsafe key) and makes each record's `id` match its
 * key. Returns the keys present before repair, so order arrays can drop removed ids silently.
 */
export function repairRecords(records: JsonObject, what: Noun, log: RepairLog): ReadonlySet<string> {
  const keysBeforeRepair = new Set(Object.keys(records));
  for (const key of keysBeforeRepair) {
    const value = records[key];
    // "__proto__" is legal in JSON, but later code assigns `records[id] = ...`, which would then change a
    // prototype instead of adding a record.
    if (key === '__proto__' || !isObject(value)) {
      delete records[key];
      log.count(`damaged ${what[0]}`, (n) => `Removed ${countOf(n, withPrefix('damaged', what))}.`);
    } else if (value.id !== key) {
      value.id = key;
      log.count(`id ${what[0]}`, (n) => `Fixed ${countOf(n, what)} stored under the wrong id.`);
    }
  }
  return keysBeforeRepair;
}

const UNKNOWN_ENTRY = noun('unknown entry', 'unknown entries');
const DUPLICATE_ENTRY = noun('duplicate entry', 'duplicate entries');

/**
 * Keeps each existing id once, in order, then appends records the order array forgot. Ids of records
 * removed during this repair (`known` but gone) are dropped without another message.
 */
export function repairOrder(
  order: readonly unknown[],
  records: JsonObject,
  known: ReadonlySet<string>,
  listName: string,
  what: Noun,
  log: RepairLog,
): string[] {
  const seen = new Set<string>();
  const repaired: string[] = [];
  let unknownCount = 0;
  let duplicateCount = 0;
  for (const id of order) {
    const hasRecord = isString(id) && hasOwn(records, id);
    if (!hasRecord) {
      const removedEarlier = isString(id) && known.has(id);
      if (!removedEarlier) unknownCount++;
    } else if (seen.has(id)) {
      duplicateCount++;
    } else {
      seen.add(id);
      repaired.push(id);
    }
  }
  const missing = Object.keys(records).filter((id) => !seen.has(id));
  repaired.push(...missing);
  if (unknownCount) log.add(`Removed ${countOf(unknownCount, UNKNOWN_ENTRY)} from the ${listName}.`);
  if (duplicateCount) log.add(`Removed ${countOf(duplicateCount, DUPLICATE_ENTRY)} from the ${listName}.`);
  if (missing.length) log.add(`Added ${countOf(missing.length, what)} missing from the ${listName}.`);
  return repaired;
}
