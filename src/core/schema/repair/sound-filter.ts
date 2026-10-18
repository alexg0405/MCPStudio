/** The shape check for `AudioClipChannel.filter`, the record a sound filter keeps of what it replaced. */
import { isBoolean, isFiniteNumber, isId, isObject, isString } from '../json-values';

/** A playlist clip as a filter remembers it: the original, put back when the filter is removed. */
const isClipCopy = (value: unknown): boolean =>
  isObject(value) &&
  isId(value.id) &&
  isId(value.laneId) &&
  isFiniteNumber(value.start) &&
  isFiniteNumber(value.length) &&
  value.length >= 1 &&
  ((value.kind === 'pattern' && isId(value.patternId) && isFiniteNumber(value.offset)) ||
    (value.kind === 'audio' && isId(value.channelId) && isFiniteNumber(value.offsetSec)) ||
    (value.kind === 'automation' && isId(value.channelId) && isFiniteNumber(value.offset)));

/** The mixer track a filter's effects are on: made for it, or borrowed empty (its `slots` removed on undo). */
const isFilterInsert = (value: unknown): boolean =>
  isObject(value) &&
  isId(value.id) &&
  isBoolean(value.made) &&
  isString(value.name) &&
  Array.isArray(value.slots) &&
  value.slots.every(isId);

/** What a speed filter changed the tempo from: the song's tempo before (BPM), or the tempo automation it added. */
const isFilterTempo = (value: unknown): boolean =>
  isObject(value) && (isFiniteNumber(value.bpm) || isId(value.channelId));

/** A structurally valid `AudioClipChannel.filter` (what it refers to may be gone: removing it skips that). */
export function isSoundFilter(value: unknown): boolean {
  if (!isObject(value) || !isString(value.preset) || !isFiniteNumber(value.from) || !isFiniteNumber(value.to)) {
    return false;
  }
  if (!Array.isArray(value.originals) || !value.originals.every(isClipCopy)) return false;
  if (!Array.isArray(value.pieces) || !value.pieces.every(isId)) return false;
  if (value.insert !== undefined && !isFilterInsert(value.insert)) return false;
  if (value.tempo !== undefined && !isFilterTempo(value.tempo)) return false;
  return true;
}
