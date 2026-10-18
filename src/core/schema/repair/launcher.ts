/**
 * Repair of the clip launcher (`Project.launcher`, optional): a grid of slots that point at patterns and
 * audio clip channels. Slots whose pattern or channel is gone are dropped, track links to deleted
 * playlist tracks too, order arrays are made to match the records, and broken settings go back to their
 * defaults.
 */
import { FOLLOW_KINDS, LAUNCH_MODES, LAUNCH_QUANTIZES } from '../../model/types';
import { type RepairLog } from './log';
import { FieldRepairs } from './fields';
import {
  hasOwn,
  isBoolean,
  isFiniteNumber,
  isIntegerBetween,
  isNonNegativeNumber,
  isObject,
  isSet,
  isString,
  type JsonObject,
} from '../json-values';

const MAX_TRACKS = 32;
const MAX_SCENES = 64;
/** The most bars a follow action may wait before it fires. */
const FOLLOW_BARS_MAX = 64;
/** The loudest gain of an audio slot (linear: +12 dB). */
const SLOT_GAIN_MAX = 4;
const DEFAULT_QUANTIZE = 'bar';

const isOneOf = (list: readonly string[]) => (value: unknown) => list.includes(value as string);
const isLaunchQuantize = isOneOf(LAUNCH_QUANTIZES);

/** What a slot's content may point at: patterns, and audio clip channels. */
interface ProjectLookups {
  patterns: JsonObject;
  channels: JsonObject;
  lanes: JsonObject;
}

/** Removes the launcher when its tables are unreadable; otherwise repairs scenes, tracks, slots and order. */
export function repairLauncher(project: JsonObject, log: RepairLog): void {
  if (!isSet(project, 'launcher')) return;
  const launcher = project.launcher;
  if (!hasReadableTables(launcher)) {
    delete project.launcher;
    log.add('Forgot the damaged clip launcher grid (patterns and clips are not changed).');
    return;
  }
  let wasFixed = false;
  if (!isLaunchQuantize(launcher.quantize)) {
    launcher.quantize = DEFAULT_QUANTIZE;
    wasFixed = true;
  }
  const lookups: ProjectLookups = {
    patterns: isObject(project.patterns) ? project.patterns : {},
    channels: isObject(project.channels) ? project.channels : {},
    lanes: isObject(project.playlist) && isObject(project.playlist.lanes) ? project.playlist.lanes : {},
  };
  const scenes = launcher.scenes as JsonObject;
  const tracks = launcher.tracks as JsonObject;
  wasFixed = repairScenes(scenes) || wasFixed;
  wasFixed = repairTracks(tracks, scenes, lookups) || wasFixed;
  wasFixed = repairRecordOrder(launcher, 'trackOrder', tracks, MAX_TRACKS) || wasFixed;
  wasFixed = repairRecordOrder(launcher, 'sceneOrder', scenes, MAX_SCENES) || wasFixed;
  if (wasFixed) log.add('Fixed the clip launcher grid (dropped slots whose pattern or audio is gone).');
}

function hasReadableTables(launcher: unknown): launcher is JsonObject {
  return (
    isObject(launcher) &&
    isObject(launcher.tracks) &&
    isObject(launcher.scenes) &&
    Array.isArray(launcher.trackOrder) &&
    Array.isArray(launcher.sceneOrder)
  );
}

/** Scenes (rows) and tracks (columns) are both records with an id, a name and an optional colour. */
function repairNameAndColor(record: JsonObject, id: string, defaultName: string): boolean {
  let wasFixed = false;
  if (record.id !== id) {
    record.id = id;
    wasFixed = true;
  }
  const fixes = new FieldRepairs(record);
  fixes.require('name', isString, defaultName);
  fixes.dropIfInvalid('color', isString);
  return fixes.changed || wasFixed;
}

function repairScenes(scenes: JsonObject): boolean {
  let wasFixed = false;
  for (const [id, scene] of Object.entries(scenes)) {
    if (!isObject(scene)) {
      delete scenes[id];
      wasFixed = true;
      continue;
    }
    wasFixed = repairNameAndColor(scene, id, 'Scene') || wasFixed;
  }
  return wasFixed;
}

function repairTracks(tracks: JsonObject, scenes: JsonObject, lookups: ProjectLookups): boolean {
  let wasFixed = false;
  for (const [id, track] of Object.entries(tracks)) {
    if (!isObject(track) || !isObject(track.slots)) {
      delete tracks[id];
      wasFixed = true;
      continue;
    }
    wasFixed = repairNameAndColor(track, id, 'Track') || wasFixed;
    // The playlist track a launcher track takes over; absent is fine, a deleted one is not.
    const fixes = new FieldRepairs(track);
    fixes.dropIfInvalid('laneId', (v) => isString(v) && hasOwn(lookups.lanes, v));
    wasFixed = fixes.changed || wasFixed;
    wasFixed = repairSlots(track.slots, scenes, lookups) || wasFixed;
  }
  return wasFixed;
}

/** Drops slots with no scene or with content that is gone; fixes the optional settings of the rest. */
function repairSlots(slots: JsonObject, scenes: JsonObject, lookups: ProjectLookups): boolean {
  let wasFixed = false;
  for (const [sceneId, slot] of Object.entries(slots)) {
    const canKeep = hasOwn(scenes, sceneId) && isObject(slot) && contentExists(slot.content, lookups);
    if (!canKeep) {
      delete slots[sceneId];
      wasFixed = true;
      continue;
    }
    const slotObject = slot as JsonObject;
    const fixes = new FieldRepairs(slotObject);
    const content = slotObject.content as JsonObject;
    if (content.kind === 'audio') repairAudioContent(content, fixes);
    fixes.dropIfInvalid('name', isString);
    fixes.dropIfInvalid('color', isString);
    fixes.dropIfInvalid('mode', isOneOf(LAUNCH_MODES));
    fixes.dropIfInvalid('loop', isBoolean);
    fixes.dropIfInvalid('quantize', isLaunchQuantize);
    fixes.dropIfInvalid('follow', isFollowAction);
    wasFixed = fixes.changed || wasFixed;
  }
  return wasFixed;
}

/** A pattern that exists, or an audio clip channel that exists with a length of at least one tick. */
function contentExists(content: unknown, lookups: ProjectLookups): boolean {
  if (!isObject(content)) return false;
  if (content.kind === 'pattern') return isString(content.patternId) && hasOwn(lookups.patterns, content.patternId);
  if (content.kind !== 'audio') return false;
  if (!isString(content.channelId) || !hasOwn(lookups.channels, content.channelId)) return false;
  const channel = lookups.channels[content.channelId];
  return isObject(channel) && channel.kind === 'audioClip' && isFiniteNumber(content.length) && content.length >= 1;
}

/** Audio content settings. The length is rounded to whole ticks; that is not reported as a repair. */
function repairAudioContent(content: JsonObject, slotFixes: FieldRepairs): void {
  const fixes = new FieldRepairs(content);
  fixes.require('offsetSec', isNonNegativeNumber, 0);
  content.length = Math.round(content.length as number);
  fixes.dropIfInvalid('gain', (v) => isFiniteNumber(v) && v >= 0 && v <= SLOT_GAIN_MAX);
  fixes.dropIfInvalid('fadeIn', isNonNegativeNumber);
  fixes.dropIfInvalid('fadeOut', isNonNegativeNumber);
  slotFixes.noteChange(fixes.changed);
}

const isFollowAction = (value: unknown): boolean =>
  isObject(value) && isOneOf(FOLLOW_KINDS)(value.kind) && isIntegerBetween(value.bars, 1, FOLLOW_BARS_MAX);

/**
 * Makes an order array match its records: valid ids once each in order, then records it forgot, at most
 * `maxCount` of them (the records beyond that are deleted). True when the array changed.
 */
function repairRecordOrder(
  launcher: JsonObject,
  key: 'trackOrder' | 'sceneOrder',
  records: JsonObject,
  maxCount: number,
): boolean {
  const original = launcher[key] as unknown[];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of original) {
    if (!isString(id) || !hasOwn(records, id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of Object.keys(records)) {
    if (!seen.has(id)) ordered.push(id);
  }
  const kept = ordered.slice(0, maxCount);
  for (const id of ordered.slice(maxCount)) delete records[id];
  launcher[key] = kept;
  return kept.length !== original.length || kept.some((id, i) => id !== original[i]);
}
