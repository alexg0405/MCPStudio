/** Repair of automation channels and the parameter targets that automation and MIDI links point at. */
import { AUTO_SHAPES } from '../../model/types';
import { BPM_MAX, BPM_MIN, TICK_MAX } from './limits';
import { FieldRepairs } from './fields';
import { clampNumber, isFiniteNumber, isId, isObject, type JsonObject } from '../json-values';

/** A structurally valid automation/controller target (it may refer to things that were deleted). */
export function isParamTarget(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'channel':
      return isId(value.channelId) && (value.param === 'volume' || value.param === 'pan' || value.param === 'pitch');
    case 'insert':
      return isId(value.insertId) && (value.param === 'volume' || value.param === 'pan');
    case 'slot':
      return isId(value.insertId) && isId(value.slotId) && value.param === 'mix';
    case 'route':
      return isId(value.insertId) && isId(value.to);
    case 'vca':
      return isId(value.groupId);
    case 'plugin':
      return isPluginOwner(value.owner) && isId(value.paramId);
    case 'midiFx':
      return isId(value.channelId) && isId(value.slotId) && isId(value.paramId);
    case 'tempo':
      return true;
    default:
      return false;
  }
}

/** The channel or effect slot that a plugin parameter target belongs to. */
function isPluginOwner(owner: unknown): boolean {
  if (!isObject(owner)) return false;
  if (owner.kind === 'channel') return isId(owner.channelId);
  return owner.kind === 'fx' && isId(owner.insertId) && isId(owner.slotId);
}

/** A value range (`min` below `max`), as an automation channel uses to scale its 0–1 points. */
const isRange = (value: unknown): boolean =>
  isObject(value) && isFiniteNumber(value.min) && isFiniteNumber(value.max) && value.min < value.max;

/**
 * Fixes the target, points and value range of an automation channel in place. True when anything had to
 * change.
 */
export function repairAutomationChannel(channel: JsonObject): boolean {
  const fixes = new FieldRepairs(channel);
  fixes.require('target', (v) => v === null || isParamTarget(v), null);
  fixes.noteChange(repairPoints(channel));
  fixes.dropIfInvalid('range', isRange);
  fixes.noteChange(clampTempoRange(channel));
  return fixes.changed;
}

/**
 * A tempo curve's range must stay inside the tempos the project allows. A range that collapses once
 * clamped (both ends at the same limit) is dropped. True when the range changed.
 */
function clampTempoRange(channel: JsonObject): boolean {
  const isTempoTarget = isObject(channel.target) && channel.target.kind === 'tempo';
  if (!isTempoTarget || !isRange(channel.range)) return false;
  const range = channel.range as JsonObject;
  const min = clampNumber(range.min as number, BPM_MIN, BPM_MAX);
  const max = clampNumber(range.max as number, BPM_MIN, BPM_MAX);
  if (min >= max) {
    delete channel.range;
    return true;
  }
  if (min === range.min && max === range.max) return false;
  channel.range = { min, max };
  return true;
}

/** Points: objects with a tick and a normalized value, sorted, with valid shapes and tensions. */
function repairPoints(channel: JsonObject): boolean {
  if (!Array.isArray(channel.points)) {
    channel.points = [];
    return true;
  }
  const original = channel.points as unknown[];
  const points = original.filter(isObject);
  let wasFixed = points.length !== original.length;
  for (const point of points) wasFixed = repairPoint(point) || wasFixed;
  if (!isSortedByTick(points)) {
    points.sort((a, b) => (a.tick as number) - (b.tick as number));
    wasFixed = true;
  }
  channel.points = points;
  return wasFixed;
}

function repairPoint(point: JsonObject): boolean {
  const fixes = new FieldRepairs(point);
  fixes.clampInteger('tick', 0, TICK_MAX, 0);
  fixes.clamp('value', 0, 1, 0);
  fixes.clampIfSet('tension', -1, 1, 0);
  fixes.dropIfInvalid('shape', (v) => AUTO_SHAPES.includes(v as never));
  return fixes.changed;
}

function isSortedByTick(points: readonly JsonObject[]): boolean {
  for (let i = 1; i < points.length; i++) {
    if ((points[i]!.tick as number) < (points[i - 1]!.tick as number)) return false;
  }
  return true;
}
