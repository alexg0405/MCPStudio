/**
 * Takes and comping: the tags that tie a recording's takes to its comp lane. Damaged tags go, and so does a
 * group that cannot work (no comp track, or no take left to comp from): its clips and tracks become ordinary
 * ones, so nothing is lost and nothing points at something that is not there.
 */
import { type RepairLog, countOf, noun } from './log';
import { clampField } from './fields';
import { isId, isIntegerBetween, isObject, isSet, type JsonObject } from '../json-values';

/** The longest crossfade between comp pieces, in milliseconds. */
const CROSSFADE_MAX_MS = 500;
const DEFAULT_CROSSFADE_MS = 10;

/** How many comp tracks and takes each take group has. */
interface GroupCounts {
  compLanes: number;
  takeClips: number;
}

/** Repairs `lane.takes` and `clip.take` tags, then un-groups every group that has no comp lane or no take. */
export function repairTakes(playlist: JsonObject, log: RepairLog): void {
  const lanes = playlist.lanes as JsonObject;
  const clips = playlist.clips as JsonObject;
  repairLaneTags(lanes, log);
  const groups = countGroups(lanes, clips, log);
  const unusableGroups = new Set(
    [...groups].filter(([, counts]) => counts.compLanes === 0 || counts.takeClips === 0).map(([group]) => group),
  );
  if (unusableGroups.size === 0) return;
  removeTagsOfGroups(unusableGroups, lanes, clips);
  const sets = unusableGroups.size === 1 ? 'a set of takes' : `${unusableGroups.size} sets of takes`;
  log.add(`Made ${sets} ordinary tracks and clips (the comp or the takes were gone).`);
}

const countDamagedTag = (log: RepairLog) =>
  log.count(
    'take-tags',
    (n) => `Removed the take or comp mark from ${countOf(n, noun('playlist track or clip'))} (it was damaged).`,
  );

/** Deletes damaged `takes` tags from playlist tracks and puts an out-of-range crossfade back in range. */
function repairLaneTags(lanes: JsonObject, log: RepairLog): void {
  for (const entry of Object.values(lanes)) {
    const lane = entry as JsonObject;
    if (!isSet(lane, 'takes')) continue;
    const tag = lane.takes;
    if (!isLaneTakeTag(tag)) {
      delete lane.takes;
      countDamagedTag(log);
    } else if (isSet(tag, 'crossfadeMs') && clampField(tag, 'crossfadeMs', 0, CROSSFADE_MAX_MS, DEFAULT_CROSSFADE_MS)) {
      countDamagedTag(log);
    }
  }
}

/** Deletes damaged `take` tags from clips, then counts the comp lanes and take clips of every group. */
function countGroups(lanes: JsonObject, clips: JsonObject, log: RepairLog): Map<string, GroupCounts> {
  const groups = new Map<string, GroupCounts>();
  const countsOf = (group: string): GroupCounts => {
    let counts = groups.get(group);
    if (!counts) {
      counts = { compLanes: 0, takeClips: 0 };
      groups.set(group, counts);
    }
    return counts;
  };
  for (const entry of Object.values(lanes)) {
    const tag = (entry as JsonObject).takes as JsonObject | undefined;
    if (tag?.role === 'comp') countsOf(tag.group as string).compLanes++;
  }
  for (const entry of Object.values(clips)) {
    const clip = entry as JsonObject;
    if (!isSet(clip, 'take')) continue;
    const tag = clip.take;
    if (!isClipTakeTag(clip, tag)) {
      delete clip.take;
      countDamagedTag(log);
      continue;
    }
    // Clips made by comping (`comp: true`) are the result, not a take to comp from.
    if (tag.comp !== true) countsOf(tag.group as string).takeClips++;
  }
  return groups;
}

function removeTagsOfGroups(groups: ReadonlySet<string>, lanes: JsonObject, clips: JsonObject): void {
  for (const entry of Object.values(lanes)) {
    const lane = entry as JsonObject;
    if (isObject(lane.takes) && groups.has(lane.takes.group as string)) delete lane.takes;
  }
  for (const entry of Object.values(clips)) {
    const clip = entry as JsonObject;
    if (isObject(clip.take) && groups.has(clip.take.group as string)) delete clip.take;
  }
}

/** A playlist track's tag: which take group it belongs to and whether it is the comp lane or a take lane. */
function isLaneTakeTag(tag: unknown): tag is JsonObject {
  return isObject(tag) && isId(tag.group) && (tag.role === 'comp' || tag.role === 'take');
}

/** An audio clip's tag: its take group and take number (and `comp: true` only on clips made by comping). */
function isClipTakeTag(clip: JsonObject, tag: unknown): tag is JsonObject {
  return (
    clip.kind === 'audio' &&
    isObject(tag) &&
    isId(tag.group) &&
    isIntegerBetween(tag.index, 0, Infinity) &&
    (!isSet(tag, 'comp') || tag.comp === true)
  );
}
