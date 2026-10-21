/**
 * The `.agrack` file: one effect rack (its branches, effects with all their settings, macros and mappings) as JSON that
 * can be saved, shared and loaded into any project. Pure and unit tested; the app adds the plugin checks and the storage.
 */
import { newId } from '../model/ids';
import { RACK_PLUGIN_ID, isRackSlot } from '../model/rack';
import type { FxSlot, Rack } from '../model/types';
import { FieldRepairs } from '../schema/repair/fields';
import { RepairLog } from '../schema/repair/log';
import { repairRackOfSlot } from '../schema/repair/rack';
import { repairPlugin } from '../schema/repair/plugin';
import { isBoolean, isObject, isString, type JsonObject } from '../schema/json-values';
import { cloneSlotWithNewIds } from './clone';

/** The `format` field of every rack file. */
export const RACK_FILE_FORMAT = 'agstudio-rack';
/** The version of the file layout this code writes and reads. */
export const RACK_FILE_VERSION = 1;
/** The longest name a saved rack may have, in characters. */
export const RACK_FILE_NAME_MAX = 64;

/** A saved rack. */
export interface RackFile {
  format: typeof RACK_FILE_FORMAT;
  version: typeof RACK_FILE_VERSION;
  name: string;
  /** One sentence about what it does (optional). */
  description?: string;
  /** The rack slot as it was: its plugin settings (macro values, output gain), dry/wet and the rack inside. */
  slot: FxSlot;
}

/** What reading a rack file gives: the rack, or the reason the file cannot be used. */
export type RackFileReading = { ok: true; file: RackFile; notes: string[] } | { ok: false; error: string };

/** The rack slot as a file: a copy with no samples (they belong to the project) and no sidechain. */
export function rackSlotToFile(slot: FxSlot, name: string, description?: string): RackFile {
  const copy = JSON.parse(JSON.stringify(slot)) as FxSlot;
  copy.sidechain = null;
  delete copy.plugin.samples;
  for (const branch of copy.rack?.branches ?? []) for (const effect of branch.fx) delete effect.plugin.samples;
  const file: RackFile = {
    format: RACK_FILE_FORMAT,
    version: RACK_FILE_VERSION,
    name: name.trim().slice(0, RACK_FILE_NAME_MAX) || 'Rack',
    slot: copy,
  };
  if (description?.trim()) file.description = description.trim();
  return file;
}

/** The file as text (indented, so it reads well in a text editor and diffs well in a repository). */
export function writeRackFile(file: RackFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

/** Every plugin id the rack needs: the effects inside it (the rack plugin itself is built in). */
export function rackFilePluginIds(file: RackFile): string[] {
  const ids = new Set<string>();
  for (const branch of file.slot.rack?.branches ?? []) for (const effect of branch.fx) ids.add(effect.plugin.pluginId);
  return [...ids];
}

/**
 * Reads the text of a rack file. Anything wrong with the file as a whole is said in plain words; small damage inside the
 * rack is repaired the way a project's is, and each repair is listed in `notes`.
 */
export function readRackFile(text: string): RackFileReading {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That is not a rack file: it is not valid JSON.' };
  }
  if (!isObject(json) || json.format !== RACK_FILE_FORMAT) return { ok: false, error: 'That is not an AGstudio rack file.' };
  if (typeof json.version !== 'number' || json.version > RACK_FILE_VERSION)
    return { ok: false, error: 'That rack was saved by a newer version of AGstudio, which this one cannot read.' };
  if (!isString(json.name) || json.name.trim() === '') return { ok: false, error: 'The rack file has no name.' };
  if (!isObject(json.slot) || !isObject(json.slot.plugin) || json.slot.plugin.pluginId !== RACK_PLUGIN_ID)
    return { ok: false, error: 'The rack file does not hold a rack.' };
  const slot = JSON.parse(JSON.stringify(json.slot)) as JsonObject;
  const log = new RepairLog();
  if (!repairPlugin(slot.plugin, {}, log)) return { ok: false, error: 'The rack file has no usable rack settings.' };
  const fixes = new FieldRepairs(slot);
  fixes.require('enabled', isBoolean, true);
  fixes.clamp('mix', 0, 1, 1);
  slot.sidechain = null;
  slot.id = newId.slot();
  repairRackOfSlot(slot, new Set([slot.id as string]), {}, log);
  log.flush();
  const file: RackFile = {
    format: RACK_FILE_FORMAT,
    version: RACK_FILE_VERSION,
    name: json.name.trim().slice(0, RACK_FILE_NAME_MAX),
    slot: slot as unknown as FxSlot,
  };
  if (isString(json.description) && json.description.trim()) file.description = json.description.trim();
  if (!isRackSlot(file.slot)) return { ok: false, error: 'The rack file does not hold a rack.' };
  return { ok: true, file, notes: log.messages };
}

/** A new rack slot from a file, with new ids (so the same rack can go on a track twice, or on many tracks). */
export function rackFileToSlot(file: RackFile): FxSlot & { rack: Rack } {
  return cloneSlotWithNewIds(file.slot) as FxSlot & { rack: Rack };
}
