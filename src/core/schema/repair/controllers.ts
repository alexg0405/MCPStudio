/** Repair of MIDI controller links (`Project.controllers`): knob or fader → parameter. */
import { type RepairLog, LINK, countOf } from './log';
import { repairRecords } from './records';
import { isParamTarget } from './automation';
import { FieldRepairs } from './fields';
import { isIntegerBetween, isObject, isString, type JsonObject } from '../json-values';

/** MIDI controller (CC) numbers run 0–127. */
const MIDI_CC_MAX = 127;
/** MIDI channels are stored 0–15 (shown as 1–16); null means any channel. */
const MIDI_CHANNEL_MAX = 15;

/** Removes links with an invalid controller number, channel or target; puts the value range in 0–1. */
export function repairControllers(project: JsonObject, log: RepairLog): void {
  if (!isObject(project.controllers)) {
    project.controllers = {};
    log.add('Reset the damaged MIDI controller links.');
    return;
  }
  const links = project.controllers;
  repairRecords(links, LINK, log);
  for (const [id, entry] of Object.entries(links)) {
    const link = entry as JsonObject;
    if (!isValidLink(link)) {
      delete links[id];
      log.count('link-bad', (n) => `Removed ${countOf(n, LINK)} with invalid settings.`);
      continue;
    }
    const fixes = new FieldRepairs(link);
    fixes.clamp('min', 0, 1, 0);
    fixes.clamp('max', 0, 1, 1);
    fixes.dropIfInvalid('device', isString);
    if (fixes.changed) log.count('link-fields', (n) => `Fixed ${countOf(n, LINK)} with an invalid range.`);
  }
  log.flush();
}

function isValidLink(link: JsonObject): boolean {
  const hasValidChannel = link.channel === null || isIntegerBetween(link.channel, 0, MIDI_CHANNEL_MAX);
  return isIntegerBetween(link.cc, 0, MIDI_CC_MAX) && hasValidChannel && isParamTarget(link.target);
}
