/**
 * Repair of the saved mixer snapshots (`Project.mixSnapshots`, optional). A snapshot holds only values, so repair
 * checks shapes and ranges: a snapshot whose tracks are unreadable is dropped, a damaged value goes back to a safe
 * one, a routing part that cannot be read is forgotten (the levels stay), and the field goes when none is left.
 * References to tracks that no longer exist are fine: a snapshot may outlive the track it remembers.
 */
import { newId } from '../../model/ids';
import { MAX_SNAPSHOTS } from '../../ops/snapshots';
import { FieldRepairs } from './fields';
import { INSERT_VOLUME_MAX } from './limits';
import { countOf, noun, type RepairLog } from './log';
import { clampNumber, isBoolean, isFiniteNumber, isId, isObject, isSet, isString, type JsonObject } from '../json-values';

const SNAPSHOT = noun('mixer snapshot');

const isParamValue = (value: unknown): boolean => isFiniteNumber(value) || isString(value) || isBoolean(value);

/** One effect slot of a snapshot; false when it cannot be read (it is then left out). */
function repairSlot(slot: unknown): boolean {
  if (!isObject(slot) || !isString(slot.plugin)) return false;
  const fixes = new FieldRepairs(slot);
  fixes.require('enabled', isBoolean, true);
  fixes.clamp('mix', 0, 1, 1);
  const params = isObject(slot.params) ? slot.params : {};
  slot.params = Object.fromEntries(Object.entries(params).filter(([, value]) => isParamValue(value)));
  return true;
}

/** Keeps the entries of a record that `isValid` accepts. */
function filterRecord(record: unknown, isValid: (value: unknown) => boolean): JsonObject {
  const source = isObject(record) ? record : {};
  return Object.fromEntries(Object.entries(source).filter(([, value]) => isValid(value)));
}

/** One track of a snapshot; false when it cannot be read. */
function repairInsert(id: string, insert: unknown): boolean {
  if (!isObject(insert)) return false;
  const fixes = new FieldRepairs(insert);
  fixes.require('name', isString, id);
  fixes.clamp('volume', 0, INSERT_VOLUME_MAX, 1);
  fixes.clamp('pan', -1, 1, 0);
  fixes.require('muted', isBoolean, false);
  fixes.require('solo', isBoolean, false);
  insert.sends = Object.fromEntries(
    Object.entries(filterRecord(insert.sends, isFiniteNumber)).map(([to, level]) => [to, clampNumber(level as number, 0, INSERT_VOLUME_MAX)]),
  );
  insert.fx = filterRecord(insert.fx, repairSlot);
  return true;
}

/** The routing of one track; false when it cannot be read. */
function isReadableRouting(routing: unknown): boolean {
  if (!isObject(routing) || !Array.isArray(routing.routes) || !isObject(routing.sidechains)) return false;
  const routesOk = routing.routes.every((route) => isObject(route) && isString(route.to) && isBoolean(route.pre));
  return routesOk && Object.values(routing.sidechains).every((source) => source === null || isString(source));
}

/** Fixes one snapshot in place; false when its tracks are unreadable. */
function repairSnapshot(snapshot: unknown): snapshot is JsonObject {
  if (!isObject(snapshot) || !isObject(snapshot.inserts)) return false;
  const inserts = filterRecord(snapshot.inserts, () => true);
  for (const [id, insert] of Object.entries(inserts)) if (!repairInsert(id, insert)) delete inserts[id];
  snapshot.inserts = inserts;
  const fixes = new FieldRepairs(snapshot);
  fixes.require('name', (value) => isString(value) && value.trim() !== '', 'Snapshot');
  fixes.require('savedAt', isFiniteNumber, 0);
  if (isSet(snapshot, 'vca')) {
    const levels = filterRecord(snapshot.vca, isFiniteNumber);
    const clamped = Object.entries(levels).map(([group, level]) => [group, clampNumber(level as number, 0, INSERT_VOLUME_MAX)]);
    if (clamped.length) snapshot.vca = Object.fromEntries(clamped);
    else delete snapshot.vca;
  }
  if (isSet(snapshot, 'routing')) {
    const routing = snapshot.routing;
    const isReadable = isObject(routing) && Object.values(routing).every(isReadableRouting);
    if (!isReadable) delete snapshot.routing;
  }
  return Object.keys(inserts).length > 0;
}

export function repairMixSnapshots(project: JsonObject, log: RepairLog): void {
  if (!isSet(project, 'mixSnapshots')) return;
  if (!Array.isArray(project.mixSnapshots)) {
    delete project.mixSnapshots;
    log.add('Forgot the damaged mixer snapshots (the mixer is not changed).');
    return;
  }
  const readable = project.mixSnapshots.filter(repairSnapshot);
  const kept = readable.slice(0, MAX_SNAPSHOTS);
  const dropped = project.mixSnapshots.length - kept.length;
  const ids = new Set<string>();
  for (const snapshot of kept) {
    if (!isId(snapshot.id) || ids.has(snapshot.id)) {
      snapshot.id = newId.snapshot();
      log.count('snapshot-id', (n) => `Gave ${countOf(n, SNAPSHOT)} a new id (missing or duplicate).`);
    }
    ids.add(snapshot.id as string);
  }
  if (dropped) log.add(`Removed ${countOf(dropped, SNAPSHOT)} that could not be read.`);
  if (kept.length === 0) delete project.mixSnapshots;
  else project.mixSnapshots = kept;
  log.flush();
}
