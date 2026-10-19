/** Repair of the mixer: its tracks (inserts), their faders, effect slots, routes and sidechains. */
import { makeInsert, masterRoutes } from '../../model/defaults';
import { newId } from '../../model/ids';
import { MASTER, type InsertId } from '../../model/types';
import { type RepairLog, INSERT, ROUTE, SLOT, countOf, noun, withPrefix } from './log';
import { INSERT_VOLUME_MAX } from './limits';
import { FieldRepairs } from './fields';
import { repairPlugin } from './plugin';
import { repairOrder, repairRecords } from './records';
import { breakRoutingCycles } from './routing-cycles';
import { hasOwn, isBoolean, isId, isObject, isString, type JsonObject } from '../json-values';

/**
 * Makes the mixer usable: a Master track that comes first, a track list that matches the tracks, sane
 * faders, valid effect slots, and routing without loops.
 */
export function repairMixer(project: JsonObject, log: RepairLog): void {
  const mixer = project.mixer as JsonObject;
  const inserts = mixer.inserts as JsonObject;
  const samples = project.samples as JsonObject;

  const knownIds = repairRecords(inserts, INSERT, log);
  const trackIds = repairTrackList(mixer, inserts, knownIds, log);

  trackIds.forEach((id, index) => {
    const insert = inserts[id] as JsonObject;
    repairInsertSettings(insert, id, index, log);
    repairRoutes(insert, id, inserts, log);
    repairEffectSlots(insert, id, inserts, samples, log);
  });
  log.flush();
  breakRoutingCycles(trackIds, inserts, log);
  log.flush();
}

/** Adds a missing Master, repairs `mixer.order` and puts the Master first. Returns the repaired order. */
function repairTrackList(
  mixer: JsonObject,
  inserts: JsonObject,
  knownIds: ReadonlySet<string>,
  log: RepairLog,
): string[] {
  let order = mixer.order as unknown[];
  if (!hasOwn(inserts, MASTER)) {
    inserts[MASTER] = makeInsert(MASTER, 'Master');
    order = [MASTER, ...order.filter((id) => id !== MASTER)];
    log.add('Added the missing Master mixer track.');
  }
  let ids = repairOrder(order, inserts, knownIds, 'mixer track list', INSERT, log);
  if (ids[0] !== MASTER) {
    ids = [MASTER, ...ids.filter((id) => id !== MASTER)];
    log.add('Moved the Master track to the first mixer slot.');
  }
  mixer.order = ids;
  return ids;
}

/** Name, mute, solo, colour, volume and pan of one mixer track. */
function repairInsertSettings(insert: JsonObject, id: string, index: number, log: RepairLog): void {
  const settings = new FieldRepairs(insert);
  settings.require('name', isString, id === MASTER ? 'Master' : `Insert ${index}`);
  settings.require('muted', isBoolean, false);
  settings.require('solo', isBoolean, false);
  settings.dropIfInvalid('color', isString);
  settings.dropIfInvalid('soloSafe', isBoolean);
  if (settings.changed) log.count('insert-fields', (n) => `Fixed ${countOf(n, INSERT)} with invalid settings.`);

  const levels = new FieldRepairs(insert);
  levels.clamp('volume', 0, INSERT_VOLUME_MAX, 1);
  levels.clamp('pan', -1, 1, 0);
  if (levels.changed) log.count('level', (n) => `Clamped ${countOf(n, noun('volume or pan setting'))} into range.`);
}

/** One route per target, to an existing insert other than itself; the master routes nowhere. */
function repairRoutes(insert: JsonObject, id: string, inserts: JsonObject, log: RepairLog): void {
  if (!Array.isArray(insert.routes)) {
    insert.routes = masterRoutes(id as InsertId);
    log.count('routes-reset', (n) => `Reset the routing of ${countOf(n, INSERT)} to the Master track.`);
    return;
  }
  const targets = new Set<string>();
  insert.routes = (insert.routes as unknown[]).filter((route) => {
    const isValid =
      id !== MASTER &&
      isObject(route) &&
      isString(route.to) &&
      route.to !== id &&
      hasOwn(inserts, route.to) &&
      !targets.has(route.to);
    if (!isValid) {
      log.count('routes-bad', (n) => `Removed ${countOf(n, ROUTE)} to missing or repeated mixer tracks.`);
      return false;
    }
    targets.add(route.to as string);
    const fixes = new FieldRepairs(route);
    fixes.clamp('level', 0, INSERT_VOLUME_MAX, 1);
    fixes.require('pre', isBoolean, false);
    if (fixes.changed) log.count('routes-fields', (n) => `Fixed ${countOf(n, ROUTE)} with invalid settings.`);
    return true;
  });
}

/** Keeps the effect slots that hold a usable plugin, with unique ids and valid mix and sidechain. */
function repairEffectSlots(
  insert: JsonObject,
  insertId: string,
  inserts: JsonObject,
  samples: JsonObject,
  log: RepairLog,
): void {
  const countDamagedSlot = () => log.count('fx-damaged', (n) => `Removed ${countOf(n, withPrefix('damaged', SLOT))}.`);
  if (!Array.isArray(insert.fx)) {
    insert.fx = [];
    countDamagedSlot();
    return;
  }
  const slotIds = new Set<string>();
  insert.fx = (insert.fx as unknown[]).filter((slot) => {
    if (!isObject(slot) || !repairPlugin(slot.plugin, samples, log)) {
      countDamagedSlot();
      return false;
    }
    if (!isId(slot.id) || slotIds.has(slot.id)) {
      slot.id = newId.slot();
      log.count('fx-id', (n) => `Gave ${countOf(n, SLOT)} a new id (missing or duplicate).`);
    }
    slotIds.add(slot.id as string);
    repairSlotSettings(slot, log);
    repairSidechain(slot, insertId, inserts, log);
    return true;
  });
}

function repairSlotSettings(slot: JsonObject, log: RepairLog): void {
  const fixes = new FieldRepairs(slot);
  fixes.require('enabled', isBoolean, true);
  fixes.clamp('mix', 0, 1, 1);
  if (fixes.changed) log.count('fx-fields', (n) => `Fixed ${countOf(n, SLOT)} with invalid settings.`);
}

/** A sidechain is either none or another existing track (a track cannot listen to itself). */
function repairSidechain(slot: JsonObject, insertId: string, inserts: JsonObject, log: RepairLog): void {
  const source = slot.sidechain;
  const isValid = source === null || (isString(source) && hasOwn(inserts, source) && source !== insertId);
  if (isValid) return;
  slot.sidechain = null;
  log.count('fx-sidechain', (n) => `Cleared ${countOf(n, noun('invalid sidechain input'))}.`);
}
