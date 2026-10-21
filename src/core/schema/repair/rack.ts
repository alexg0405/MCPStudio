/**
 * Repair of effect racks (`FxSlot.rack`, optional): a rack slot gets a usable rack (branches in the number its split
 * takes, crossovers in order, eight macros), its effects are checked like effects on the insert, and a macro keeps only
 * the mappings whose target is really in the rack. A `rack` on a slot that is not a rack is dropped.
 */
import { newId } from '../../model/ids';
import {
  BRANCH_LEVEL_MAX_DB,
  BRANCH_LEVEL_MIN_DB,
  CROSSOVER_MAX_HZ,
  CROSSOVER_MIN_HZ,
  CROSSOVER_MIN_RATIO,
  MACRO_COUNT,
  MAX_BRANCH_FX,
  MAX_MACRO_MAPPINGS,
  RACK_NAME_MAX,
  RACK_PLUGIN_ID,
  branchCountRange,
  defaultBranchNames,
  defaultCrossovers,
  makeBranch,
  makeMacros,
} from '../../model/rack';
import type { RackSplit } from '../../model/types';
import { FieldRepairs } from './fields';
import { countOf, noun, type RepairLog } from './log';
import { repairPlugin } from './plugin';
import { hasOwn, isBoolean, isFiniteNumber, isId, isObject, isSet, isString, type JsonObject } from '../json-values';

const RACK = noun('effect rack');
const BRANCH = noun('rack branch', 'rack branches');
const MACRO_MAPPING = noun('macro mapping');
const SPLITS: readonly RackSplit[] = ['parallel', 'bands', 'midside', 'leftright'];
const CURVES = ['linear', 'exponential', 'inverted'];
/** True for a name longer than a rack's names may be. */
const isTooLong = (name: string): boolean => name.length > RACK_NAME_MAX;

/** What repair knows about a rack's insides while it checks the macros: the ids that are really there. */
interface RackContents {
  effectIds: Set<string>;
  branchIds: Set<string>;
  split: RackSplit;
  crossoverCount: number;
}

/** A rack slot's `rack` field is checked (and rebuilt when it is not usable); any other slot loses a stray one. */
export function repairRackOfSlot(slot: JsonObject, slotIds: Set<string>, samples: JsonObject, log: RepairLog): void {
  const plugin = slot.plugin as JsonObject;
  if (plugin.pluginId !== RACK_PLUGIN_ID) {
    if (isSet(slot, 'rack')) {
      delete slot.rack;
      log.count('rack-stray', (n) => `Removed the rack data from ${countOf(n, noun('effect that is not a rack', 'effects that are not racks'))}.`);
    }
    return;
  }
  if (!isObject(slot.rack)) {
    slot.rack = emptyRack();
    log.count('rack-rebuilt', (n) => `Gave ${countOf(n, RACK)} with no usable contents an empty rack.`);
    return;
  }
  const rack = slot.rack;
  const split = SPLITS.includes(rack.split as RackSplit) ? (rack.split as RackSplit) : 'parallel';
  if (rack.split !== split) log.count('rack-split', (n) => `Reset the split of ${countOf(n, RACK)}.`);
  rack.split = split;
  const branches = repairBranches(rack, split, slotIds, samples, log);
  repairCrossovers(rack, split, branches.length, log);
  const contents: RackContents = {
    effectIds: new Set(branches.flatMap((branch) => (branch.fx as JsonObject[]).map((fx) => fx.id as string))),
    branchIds: new Set(branches.map((branch) => branch.id as string)),
    split,
    crossoverCount: (rack.crossovers as number[]).length,
  };
  repairMacros(rack, contents, log);
}

/** A rack with one empty branch, as JSON. */
function emptyRack(): JsonObject {
  return {
    split: 'parallel',
    crossovers: [],
    branches: [makeBranch('Chain')],
    macros: makeMacros(),
  } as unknown as JsonObject;
}

/** Fixes the branches in place; returns them (at least the number the split needs, at most four). */
function repairBranches(rack: JsonObject, split: RackSplit, slotIds: Set<string>, samples: JsonObject, log: RepairLog): JsonObject[] {
  const found = Array.isArray(rack.branches) ? (rack.branches as unknown[]).filter(isObject) : [];
  const range = branchCountRange(split);
  if (!Array.isArray(rack.branches) || found.length !== (rack.branches as unknown[]).length || found.length > range.max) {
    log.count('rack-branches', (n) => `Dropped unusable branches from ${countOf(n, RACK)}.`);
  }
  const branches = found.slice(0, range.max);
  while (branches.length < range.min) branches.push(makeBranch(`Branch ${branches.length + 1}`) as unknown as JsonObject);
  const branchIds = new Set<string>();
  branches.forEach((branch, index) => {
    repairBranchSettings(branch, defaultBranchNames(split, branches.length)[index] ?? `Branch ${index + 1}`, log);
    if (!isId(branch.id) || branchIds.has(branch.id)) {
      branch.id = newId.branch();
      log.count('branch-id', (n) => `Gave ${countOf(n, BRANCH)} a new id (missing or duplicate).`);
    }
    branchIds.add(branch.id as string);
    branch.fx = repairBranchEffects(branch, slotIds, samples, log);
  });
  rack.branches = branches;
  return branches;
}

function repairBranchSettings(branch: JsonObject, fallbackName: string, log: RepairLog): void {
  const fixes = new FieldRepairs(branch);
  fixes.require('name', (value) => isString(value) && value.trim() !== '', fallbackName);
  fixes.require('muted', isBoolean, false);
  fixes.require('solo', isBoolean, false);
  fixes.clamp('levelDb', BRANCH_LEVEL_MIN_DB, BRANCH_LEVEL_MAX_DB, 0);
  fixes.clamp('pan', -1, 1, 0);
  if (isString(branch.name) && isTooLong(branch.name)) {
    branch.name = branch.name.slice(0, RACK_NAME_MAX);
    fixes.noteChange(true);
  }
  if (fixes.changed) log.count('branch-fields', (n) => `Fixed ${countOf(n, BRANCH)} with invalid settings.`);
}

/** The branch's effects that are usable: a plugin, a unique id, no rack inside a rack, no sidechain. */
function repairBranchEffects(branch: JsonObject, slotIds: Set<string>, samples: JsonObject, log: RepairLog): JsonObject[] {
  const fx = Array.isArray(branch.fx) ? (branch.fx as unknown[]) : [];
  const kept: JsonObject[] = [];
  for (const slot of fx) {
    const isUsable =
      isObject(slot) &&
      repairPlugin(slot.plugin, samples, log) &&
      (slot.plugin as JsonObject).pluginId !== RACK_PLUGIN_ID &&
      kept.length < MAX_BRANCH_FX;
    if (!isUsable) {
      log.count('rack-fx-bad', (n) => `Removed ${countOf(n, noun('unusable effect'))} from rack branches.`);
      continue;
    }
    repairInnerSlot(slot as JsonObject, slotIds, log);
    kept.push(slot as JsonObject);
  }
  return kept;
}

function repairInnerSlot(slot: JsonObject, slotIds: Set<string>, log: RepairLog): void {
  if (!isId(slot.id) || slotIds.has(slot.id)) {
    slot.id = newId.slot();
    log.count('fx-id', (n) => `Gave ${countOf(n, noun('effect slot'))} a new id (missing or duplicate).`);
  }
  slotIds.add(slot.id as string);
  const fixes = new FieldRepairs(slot);
  fixes.require('enabled', isBoolean, true);
  fixes.clamp('mix', 0, 1, 1);
  fixes.noteChange(slot.sidechain !== null);
  slot.sidechain = null;
  fixes.noteChange(hasOwn(slot, 'rack'));
  delete slot.rack;
  if (fixes.changed) log.count('fx-fields', (n) => `Fixed ${countOf(n, noun('effect slot'))} with invalid settings.`);
}

/** Crossovers: as many as the bands need less one, in ascending order, inside the audible range and apart from each other. */
function repairCrossovers(rack: JsonObject, split: RackSplit, branchCount: number, log: RepairLog): void {
  if (split !== 'bands') {
    if (!Array.isArray(rack.crossovers) || rack.crossovers.length > 0) {
      log.count('rack-crossovers', (n) => `Fixed the crossovers of ${countOf(n, RACK)}.`);
    }
    rack.crossovers = [];
    return;
  }
  const given = Array.isArray(rack.crossovers) ? (rack.crossovers as unknown[]).filter(isFiniteNumber) : [];
  const wanted = branchCount - 1;
  const fallback = defaultCrossovers(branchCount);
  const fixed: number[] = [];
  for (let i = 0; i < wanted; i++) {
    const floor = i === 0 ? CROSSOVER_MIN_HZ : (fixed[i - 1] as number) * CROSSOVER_MIN_RATIO;
    const value = given[i] ?? fallback[i] ?? floor;
    fixed.push(Math.min(CROSSOVER_MAX_HZ, Math.max(floor, value)));
  }
  const isSame = Array.isArray(rack.crossovers) && fixed.length === rack.crossovers.length && fixed.every((v, i) => v === (rack.crossovers as number[])[i]);
  if (!isSame) log.count('rack-crossovers', (n) => `Fixed the crossovers of ${countOf(n, RACK)}.`);
  rack.crossovers = fixed;
}

/** Eight macros with names; each keeps only the mappings of targets that exist, one macro per target. */
function repairMacros(rack: JsonObject, contents: RackContents, log: RepairLog): void {
  const given = Array.isArray(rack.macros) ? (rack.macros as unknown[]) : [];
  const defaults = makeMacros();
  const taken = new Set<string>();
  rack.macros = defaults.map((fallback, index) => {
    const macro = isObject(given[index]) ? (given[index] as JsonObject) : ({ ...fallback } as unknown as JsonObject);
    const nameIsBad = !isString(macro.name) || macro.name.trim() === '';
    if (nameIsBad) macro.name = fallback.name;
    else if (isTooLong(macro.name as string)) macro.name = (macro.name as string).slice(0, RACK_NAME_MAX);
    macro.mappings = repairMappings(macro, contents, taken, log);
    return macro;
  });
  if (given.length !== MACRO_COUNT) log.count('rack-macros', (n) => `Gave ${countOf(n, RACK)} their eight macros.`);
}

function repairMappings(macro: JsonObject, contents: RackContents, taken: Set<string>, log: RepairLog): JsonObject[] {
  const mappings = Array.isArray(macro.mappings) ? (macro.mappings as unknown[]) : [];
  const kept: JsonObject[] = [];
  for (const mapping of mappings) {
    const key = isObject(mapping) ? mappingKey(mapping, contents) : null;
    const isUsable =
      isObject(mapping) &&
      key !== null &&
      !taken.has(key) &&
      isFiniteNumber(mapping.min) &&
      isFiniteNumber(mapping.max) &&
      CURVES.includes(mapping.curve as string) &&
      kept.length < MAX_MACRO_MAPPINGS;
    if (!isUsable) {
      log.count('mapping-bad', (n) => `Removed ${countOf(n, MACRO_MAPPING)} that no longer points at anything.`);
      continue;
    }
    taken.add(key);
    kept.push(mapping as JsonObject);
  }
  return kept;
}

/** A string naming the thing a mapping drives, or null when the mapping's target is unusable or not in the rack. */
function mappingKey(mapping: JsonObject, contents: RackContents): string | null {
  const target = mapping.target;
  if (!isObject(target)) return null;
  switch (target.kind) {
    case 'param':
      return isString(target.slotId) && isString(target.paramId) && contents.effectIds.has(target.slotId)
        ? `param:${target.slotId}:${target.paramId}`
        : null;
    case 'mix':
      return isString(target.slotId) && contents.effectIds.has(target.slotId) ? `mix:${target.slotId}` : null;
    case 'branch':
      return isString(target.branchId) && contents.branchIds.has(target.branchId) && (target.param === 'level' || target.param === 'pan')
        ? `branch:${target.branchId}:${target.param}`
        : null;
    case 'crossover':
      return contents.split === 'bands' && Number.isInteger(target.index) && (target.index as number) >= 0 && (target.index as number) < contents.crossoverCount
        ? `crossover:${target.index}`
        : null;
    case 'gain':
      return 'gain';
    default:
      return null;
  }
}
