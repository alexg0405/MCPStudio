/**
 * Repair of the mixer groups (`Mixer.groups`, optional): a group keeps only members that are real tracks (never the
 * master, each track in one group), loses broken settings back to defaults, and goes when it has no member left. The
 * field itself is removed when no group is left.
 */
import { paletteColor } from '../../model/defaults';
import { newId } from '../../model/ids';
import { MASTER } from '../../model/types';
import { FieldRepairs } from './fields';
import { INSERT_VOLUME_MAX } from './limits';
import { countOf, noun, type RepairLog } from './log';
import { hasOwn, isBoolean, isId, isObject, isSet, isString, type JsonObject } from '../json-values';

const GROUP = noun('mixer group');
const MODES = ['relative', 'absolute'];

/** The links of a group: each switch is on unless it says otherwise. */
function repairLinks(group: JsonObject): boolean {
  if (!isObject(group.links)) {
    group.links = { volume: true, pan: true, mute: true, solo: true };
    return true;
  }
  const links = new FieldRepairs(group.links);
  for (const control of ['volume', 'pan', 'mute', 'solo']) links.require(control, isBoolean, true);
  return links.changed;
}

/** The members that exist and are not already in an earlier group. */
function usableMembers(group: JsonObject, inserts: JsonObject, taken: Set<string>): string[] {
  const members = Array.isArray(group.members) ? group.members : [];
  const kept: string[] = [];
  for (const member of members) {
    if (!isString(member) || member === MASTER || !hasOwn(inserts, member) || taken.has(member)) continue;
    taken.add(member);
    kept.push(member);
  }
  return kept;
}

/** Fixes one group in place; false when it has nothing left and should go. */
function repairGroup(group: JsonObject, index: number, inserts: JsonObject, taken: Set<string>, log: RepairLog): boolean {
  const members = usableMembers(group, inserts, taken);
  if (members.length === 0) return false;
  const fixes = new FieldRepairs(group);
  fixes.noteChange(!Array.isArray(group.members) || group.members.length !== members.length);
  group.members = members;
  fixes.require('name', (value) => isString(value) && value.trim() !== '', `Group ${index + 1}`);
  fixes.require('color', isString, paletteColor(index));
  fixes.require('mode', (value) => MODES.includes(value as string), 'relative');
  fixes.noteChange(repairLinks(group));
  if (isSet(group, 'vca')) fixes.clamp('vca', 0, INSERT_VOLUME_MAX, 1);
  if (fixes.changed) log.count('group-fields', (n) => `Fixed ${countOf(n, GROUP)} with invalid settings.`);
  return true;
}

export function repairGroups(project: JsonObject, log: RepairLog): void {
  const mixer = project.mixer as JsonObject;
  if (!isSet(mixer, 'groups')) return;
  if (!Array.isArray(mixer.groups)) {
    delete mixer.groups;
    log.add('Forgot the damaged mixer groups (the tracks are not changed).');
    return;
  }
  const inserts = mixer.inserts as JsonObject;
  const taken = new Set<string>();
  const ids = new Set<string>();
  let dropped = 0;
  const kept = (mixer.groups as unknown[]).filter((group, index) => {
    const isUsable = isObject(group) && repairGroup(group, index, inserts, taken, log);
    if (!isUsable) dropped++;
    return isUsable;
  }) as JsonObject[];
  for (const group of kept) {
    if (!isId(group.id) || ids.has(group.id)) {
      group.id = newId.group();
      log.count('group-id', (n) => `Gave ${countOf(n, GROUP)} a new id (missing or duplicate).`);
    }
    ids.add(group.id as string);
  }
  if (dropped) log.add(`Removed ${countOf(dropped, GROUP)} with no usable tracks.`);
  if (kept.length === 0) delete mixer.groups;
  else mixer.groups = kept;
  log.flush();
}
