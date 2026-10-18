/** Repair of a saved plugin instance (`PluginInstance`), shared by instrument channels and effect slots. */
import { type RepairLog, countOf, noun } from './log';
import { requireField } from './fields';
import { hasOwn, isBoolean, isFiniteNumber, isObject, isSet, isString, type JsonObject } from '../json-values';

/** The values a plugin parameter can hold: a number, a toggle or an option id. */
const isParamValue = (value: unknown): boolean => isString(value) || isBoolean(value) || isFiniteNumber(value);

/**
 * Sanitizes a plugin instance in place; false when it is unusable (no plugin id). Parameters of the
 * wrong type are dropped (the plugin falls back to its default) and sample slots pointing at a sample
 * entry that no longer exists are cleared.
 */
export function repairPlugin(plugin: unknown, samples: JsonObject, log: RepairLog): boolean {
  if (!isObject(plugin) || !isString(plugin.pluginId) || plugin.pluginId === '') return false;
  let wasFixed = requireField(plugin, 'pluginVersion', isFiniteNumber, 1);
  wasFixed = repairParams(plugin) || wasFixed;
  wasFixed = repairSampleSlots(plugin, samples, log) || wasFixed;
  if (wasFixed) log.count('plugin', (n) => `Fixed damaged settings in ${countOf(n, noun('plugin'))}.`);
  return true;
}

/** Makes `params` an object holding only valid values. True when anything was changed. */
function repairParams(plugin: JsonObject): boolean {
  if (!isObject(plugin.params)) {
    plugin.params = {};
    return true;
  }
  let wasFixed = false;
  for (const [paramId, value] of Object.entries(plugin.params)) {
    if (isParamValue(value)) continue;
    delete plugin.params[paramId];
    wasFixed = true;
  }
  return wasFixed;
}

/**
 * Drops sample slots that point at missing samples. A damaged `samples` field is deleted outright and
 * counts as a plugin fix; dropped slots are counted as "references to missing samples" instead.
 */
function repairSampleSlots(plugin: JsonObject, samples: JsonObject, log: RepairLog): boolean {
  if (!isSet(plugin, 'samples')) return false;
  if (!isObject(plugin.samples)) {
    delete plugin.samples;
    return true;
  }
  for (const [slot, sampleId] of Object.entries(plugin.samples)) {
    if (isString(sampleId) && hasOwn(samples, sampleId)) continue;
    delete plugin.samples[slot];
    log.count('sample-ref', (n) => `Removed ${countOf(n, noun('reference'))} to missing samples.`);
  }
  return false;
}
