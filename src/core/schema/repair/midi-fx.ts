/**
 * Repair of a channel's MIDI effects chain (`InstrumentChannel.midiFx`): the chain is a list of slots, each an effect id, a
 * bypass switch and settings. A slot of an effect this version does not know is kept (a newer version may have made it); one
 * that is not even a slot is dropped. Settings of known effects are clamped into their params' ranges.
 */
import { sanitize } from '@agstudio/sdk/params';
import { MAX_MIDI_FX, midiFxDef } from '../../midi-fx/registry';
import { isBoolean, isFiniteNumber, isId, isObject, isString, type JsonObject } from '../json-values';
import { countOf, noun, type RepairLog } from './log';

const MIDI_EFFECT = noun('MIDI effect');

/** The values a setting can hold: a number, a switch or an option id. */
const isSettingValue = (value: unknown): boolean => isString(value) || isBoolean(value) || isFiniteNumber(value);

/** Makes the channel's `midiFx` a clean list of slots, or removes it when nothing usable is left. */
export function repairMidiFx(channel: JsonObject, log: RepairLog): void {
  if (!Object.hasOwn(channel, 'midiFx')) return;
  if (channel.kind !== 'instrument' || !Array.isArray(channel.midiFx)) {
    delete channel.midiFx;
    log.count('midi-fx-chain', (n) => `Removed ${countOf(n, noun('damaged MIDI effects chain'))}.`);
    return;
  }
  const kept: JsonObject[] = [];
  const usedIds = new Set<string>();
  for (const entry of channel.midiFx as unknown[]) {
    if (!isObject(entry) || !isId(entry.effect)) {
      log.count('midi-fx-slot', (n) => `Removed ${countOf(n, noun('damaged MIDI effect'))}.`);
      continue;
    }
    if (kept.length >= MAX_MIDI_FX) {
      log.count('midi-fx-extra', (n) => `Removed ${countOf(n, MIDI_EFFECT)} past the limit of ${MAX_MIDI_FX} on a channel.`);
      continue;
    }
    repairSlot(entry, kept.length, usedIds, log);
    kept.push(entry);
  }
  if (kept.length === 0) delete channel.midiFx;
  else channel.midiFx = kept;
}

/** Fixes one slot in place: a unique id, a bypass switch, and a settings object holding only valid values. */
function repairSlot(slot: JsonObject, index: number, usedIds: Set<string>, log: RepairLog): void {
  let wasFixed = false;
  if (!isId(slot.id) || usedIds.has(slot.id)) {
    slot.id = freshId(index, usedIds);
    wasFixed = true;
  }
  usedIds.add(slot.id as string);
  if (!isBoolean(slot.enabled)) {
    slot.enabled = true;
    wasFixed = true;
  }
  if (!isObject(slot.params)) {
    slot.params = {};
    wasFixed = true;
  }
  wasFixed = repairSettings(slot) || wasFixed;
  if (wasFixed) log.count('midi-fx-fields', (n) => `Fixed damaged settings in ${countOf(n, MIDI_EFFECT)}.`);
}

/** A slot id that nothing in the chain uses yet (repair has no random source: the index makes it repeatable). */
function freshId(index: number, usedIds: ReadonlySet<string>): string {
  let attempt = index;
  while (usedIds.has(`mfx_repaired${attempt}`)) attempt++;
  return `mfx_repaired${attempt}`;
}

/** Drops values of the wrong kind and clamps those of a known effect into the range of their param. True when anything changed. */
function repairSettings(slot: JsonObject): boolean {
  const params = slot.params as JsonObject;
  const def = midiFxDef(slot.effect as string);
  let wasFixed = false;
  for (const [id, value] of Object.entries(params)) {
    if (!isSettingValue(value)) {
      delete params[id];
      wasFixed = true;
      continue;
    }
    const spec = def?.params[id];
    if (!spec) continue;
    const checked = sanitize(spec, value);
    if (checked !== value) {
      params[id] = checked;
      wasFixed = true;
    }
  }
  return wasFixed;
}
