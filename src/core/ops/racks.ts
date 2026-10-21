/**
 * Draft mutators for effect racks (see `docs/architecture.md`, "Effect racks"): making, grouping and ungrouping racks,
 * their branches and crossovers, the effects inside and the macros. Call them inside `history.transact()` so every
 * edit is one undo step. An edit that cannot be made returns false (or a reason), and changes nothing.
 */
import type { Draft } from 'immer';
import {
  BRANCH_LEVEL_MAX_DB,
  BRANCH_LEVEL_MIN_DB,
  CROSSOVER_MAX_HZ,
  CROSSOVER_MIN_HZ,
  CROSSOVER_MIN_RATIO,
  MAX_BRANCH_FX,
  MAX_MACRO_MAPPINGS,
  RACK_NAME_MAX,
  RACK_PLUGIN_ID,
  branchCountRange,
  defaultBranchNames,
  defaultCrossovers,
  makeBranch,
  makeFxSlot,
  makeRackSlot,
  sameMacroTarget,
} from '../model/rack';
import { newId } from '../model/ids';
import { clampNumber } from '../schema/json-values';
import type {
  BranchId,
  FxSlot,
  InsertId,
  MacroMapping,
  MacroTarget,
  PluginInstance,
  Project,
  Rack,
  RackBranch,
  RackSplit,
  SlotId,
} from '../model/types';
import { targetUsesSlot } from '../model/targets';
import { findBranch, locateSlot, macroTargetExists } from '../query/rack';
import { dropControllers } from './channels';
import { MAX_FX_SLOTS } from './mixer';

/** The outcome of an edit that can be refused for a reason the musician should hear. */
export type RackEditResult = { ok: true } | { ok: false; reason: string };

type RackSlotDraft = Draft<FxSlot> & { rack: Draft<Rack> };

/** The rack slot of an insert, or undefined when there is none with that id. */
function rackSlotIn(d: Draft<Project>, insertId: InsertId, slotId: SlotId): RackSlotDraft | undefined {
  const slot = d.mixer.inserts[insertId]?.fx.find((candidate) => candidate.id === slotId);
  return slot && slot.rack && slot.plugin.pluginId === RACK_PLUGIN_ID ? (slot as RackSlotDraft) : undefined;
}

/** Drops the controller links that point at effects that left (or were removed from) the rack. */
function dropSlotLinks(d: Draft<Project>, insertId: InsertId, slots: readonly { id: SlotId }[]): void {
  for (const slot of slots) dropControllers(d, (target) => targetUsesSlot(target, insertId, slot.id));
}

/** Removes every mapping whose target is no longer in the rack. Run after anything that takes a target away. */
export function pruneMappings(rack: Draft<Rack>): void {
  for (const macro of rack.macros) {
    for (let i = macro.mappings.length - 1; i >= 0; i--) {
      if (!macroTargetExists(rack as Rack, (macro.mappings[i] as MacroMapping).target)) macro.mappings.splice(i, 1);
    }
  }
}

// ── Making racks ─────────────────────────────────────────────────────────────────────────────────

/**
 * Adds an empty rack to the insert at `index` (default: after the last slot). A new rack has one branch, so it is a
 * plain chain until a second branch or another split is chosen. Returns its slot id, or null when the insert is full.
 */
export function addRackSlot(
  d: Draft<Project>,
  insertId: InsertId,
  options: { index?: number; split?: RackSplit; branches?: number; id?: SlotId } = {},
): SlotId | null {
  const insert = d.mixer.inserts[insertId];
  const id = options.id ?? newId.slot();
  if (!insert || insert.fx.length >= MAX_FX_SLOTS || locateSlot(insert, id)) return null;
  const slot = makeRackSlot(options.split ?? 'parallel', options.branches ?? 0, id);
  const at = options.index === undefined ? insert.fx.length : clampNumber(Math.round(options.index), 0, insert.fx.length);
  insert.fx.splice(at, 0, slot as Draft<FxSlot>);
  return id;
}

/**
 * Puts the chosen effects of an insert into one new rack (a single branch holding them in their order), at the place of
 * the first of them. They keep their ids, so automation and controller links still find them.
 */
export function groupIntoRack(
  d: Draft<Project>,
  insertId: InsertId,
  slotIds: readonly SlotId[],
): RackEditResult & { slotId?: SlotId } {
  const insert = d.mixer.inserts[insertId];
  if (!insert) return { ok: false, reason: 'That mixer track is gone.' };
  const wanted = new Set(slotIds);
  const picked = insert.fx.filter((slot) => wanted.has(slot.id));
  if (picked.length === 0) return { ok: false, reason: 'Pick at least one effect to put in a rack.' };
  if (picked.some((slot) => slot.rack)) return { ok: false, reason: 'A rack cannot go inside another rack.' };
  if (picked.some((slot) => slot.sidechain !== null))
    return { ok: false, reason: 'An effect with a sidechain input cannot go in a rack: clear its sidechain first.' };
  if (picked.length > MAX_BRANCH_FX) return { ok: false, reason: `A branch holds at most ${MAX_BRANCH_FX} effects.` };
  const firstIndex = insert.fx.findIndex((slot) => wanted.has(slot.id));
  const rackSlot = makeRackSlot('parallel', 1);
  const branch = (rackSlot.rack as Rack).branches[0] as RackBranch;
  branch.fx = picked.map((slot) => slot as unknown as FxSlot);
  insert.fx = insert.fx.filter((slot) => !wanted.has(slot.id));
  insert.fx.splice(firstIndex, 0, rackSlot as Draft<FxSlot>);
  return { ok: true, slotId: rackSlot.id };
}

/**
 * Takes a rack apart: its effects go back on the insert, in place of the rack, branch after branch. A rack with one
 * branch is turned into the same chain without a change in sound; the macros and the other branches' parallel routing
 * are lost.
 */
export function ungroupRack(d: Draft<Project>, insertId: InsertId, slotId: SlotId): RackEditResult {
  const insert = d.mixer.inserts[insertId];
  const rackSlot = rackSlotIn(d, insertId, slotId);
  if (!insert || !rackSlot) return { ok: false, reason: 'That is not a rack.' };
  const inner = rackSlot.rack.branches.flatMap((branch) => branch.fx);
  if (insert.fx.length - 1 + inner.length > MAX_FX_SLOTS)
    return { ok: false, reason: `The track would have more than ${MAX_FX_SLOTS} effects.` };
  const index = insert.fx.findIndex((slot) => slot.id === slotId);
  insert.fx.splice(index, 1, ...(inner as Draft<FxSlot>[]));
  dropControllers(d, (target) => targetUsesSlot(target, insertId, slotId));
  return { ok: true };
}

// ── Split, branches and crossovers ────────────────────────────────────────────────────────────

/** Renames branches that still have the names their old split gave them. */
function renameDefaultBranches(rack: Draft<Rack>, oldSplit: RackSplit, oldCount: number): void {
  const oldNames = defaultBranchNames(oldSplit, oldCount);
  const newNames = defaultBranchNames(rack.split, rack.branches.length);
  rack.branches.forEach((branch, i) => {
    const isStillDefault = branch.name === oldNames[i] || /^Branch \d+$/.test(branch.name);
    if (isStillDefault && newNames[i]) branch.name = newNames[i] as string;
  });
}

/**
 * Changes how the rack splits its input. The branches stay (more are added or the last ones removed when the new split
 * takes a different number), and branches that still have their default names are renamed to the new split's.
 */
export function setRackSplit(d: Draft<Project>, insertId: InsertId, slotId: SlotId, split: RackSplit): boolean {
  const rackSlot = rackSlotIn(d, insertId, slotId);
  if (!rackSlot) return false;
  const rack = rackSlot.rack;
  if (rack.split === split) return true;
  const oldSplit = rack.split;
  const oldCount = rack.branches.length;
  const range = branchCountRange(split);
  const count = clampNumber(oldCount, range.min, range.max);
  const removed = rack.branches.splice(count);
  dropSlotLinks(d, insertId, removed.flatMap((branch) => branch.fx));
  while (rack.branches.length < count) rack.branches.push(makeBranch(`Branch ${rack.branches.length + 1}`) as Draft<RackBranch>);
  const keepsBands = split === 'bands' && oldSplit === 'bands' && rack.crossovers.length === count - 1;
  rack.split = split;
  rack.crossovers = split === 'bands' ? (keepsBands ? rack.crossovers : defaultCrossovers(count)) : [];
  renameDefaultBranches(rack, oldSplit, oldCount);
  pruneMappings(rack);
  return true;
}

/** The frequency of a new top band: halfway (in octaves) between the highest crossover and the top of the range. */
function nextTopCrossover(crossovers: readonly number[]): number {
  const last = crossovers[crossovers.length - 1] ?? 250;
  return clampNumber(Math.sqrt(last * CROSSOVER_MAX_HZ), CROSSOVER_MIN_HZ, CROSSOVER_MAX_HZ);
}

/**
 * Adds an empty branch (at `index`, default last). A `bands` rack gets a new top band instead, whatever the index; a mid/side
 * or left/right rack always has exactly two branches. Returns the new branch's id, or null when there is no room.
 */
export function addBranch(
  d: Draft<Project>,
  insertId: InsertId,
  slotId: SlotId,
  options: { name?: string; index?: number } = {},
): BranchId | null {
  const rackSlot = rackSlotIn(d, insertId, slotId);
  if (!rackSlot) return null;
  const rack = rackSlot.rack;
  if (rack.branches.length >= branchCountRange(rack.split).max) return null;
  const branch = makeBranch(options.name?.trim().slice(0, RACK_NAME_MAX) || `Branch ${rack.branches.length + 1}`);
  if (rack.split === 'bands') {
    rack.crossovers.push(nextTopCrossover(rack.crossovers));
    rack.branches.push(branch as Draft<RackBranch>);
    if (!options.name) renameDefaultBands(rack);
    return branch.id;
  }
  const at = options.index === undefined ? rack.branches.length : clampNumber(Math.round(options.index), 0, rack.branches.length);
  rack.branches.splice(at, 0, branch as Draft<RackBranch>);
  return branch.id;
}

/** After a band is added or removed, bands that still have a default name get the names of the new count. */
function renameDefaultBands(rack: Draft<Rack>): void {
  const names = defaultBranchNames('bands', rack.branches.length);
  rack.branches.forEach((branch, i) => {
    const isDefault = /^(Low|Mid|High|Low-mid|High-mid|Branch \d+)$/.test(branch.name);
    if (isDefault && names[i]) branch.name = names[i] as string;
  });
}

/** Removes a branch with its effects. A `bands` rack merges the band into the one next to it (one crossover goes). */
export function removeBranch(d: Draft<Project>, insertId: InsertId, slotId: SlotId, branchId: BranchId): boolean {
  const rackSlot = rackSlotIn(d, insertId, slotId);
  if (!rackSlot) return false;
  const rack = rackSlot.rack;
  const index = rack.branches.findIndex((branch) => branch.id === branchId);
  if (index < 0 || rack.branches.length <= branchCountRange(rack.split).min) return false;
  const [removed] = rack.branches.splice(index, 1);
  if (removed) dropSlotLinks(d, insertId, removed.fx);
  if (rack.split === 'bands') {
    const gone = Math.min(index === 0 ? 0 : index - 1, rack.crossovers.length - 1);
    rack.crossovers.splice(gone, 1);
    for (const macro of rack.macros) {
      macro.mappings = macro.mappings.flatMap((mapping) => {
        if (mapping.target.kind !== 'crossover' || mapping.target.index < gone) return [mapping];
        if (mapping.target.index === gone) return [];
        return [{ ...mapping, target: { kind: 'crossover' as const, index: mapping.target.index - 1 } }];
      });
    }
    renameDefaultBands(rack);
  }
  pruneMappings(rack);
  return true;
}

/** Moves a branch to another place in a `parallel` rack (the other splits give each branch a meaning by its place). */
export function moveBranch(d: Draft<Project>, insertId: InsertId, slotId: SlotId, branchId: BranchId, toIndex: number): boolean {
  const rack = rackSlotIn(d, insertId, slotId)?.rack;
  if (!rack || rack.split !== 'parallel') return false;
  const from = rack.branches.findIndex((branch) => branch.id === branchId);
  if (from < 0) return false;
  const to = clampNumber(Math.round(toIndex), 0, rack.branches.length - 1);
  if (to === from) return true;
  const [branch] = rack.branches.splice(from, 1);
  if (branch) rack.branches.splice(to, 0, branch);
  return true;
}

/** The settings of a branch that `setBranch` changes. */
export interface BranchSettings {
  name?: string;
  levelDb?: number;
  pan?: number;
  muted?: boolean;
  solo?: boolean;
}

/** Changes a branch's name, level (dB), pan, mute or solo. */
export function setBranch(
  d: Draft<Project>,
  insertId: InsertId,
  slotId: SlotId,
  branchId: BranchId,
  settings: BranchSettings,
): boolean {
  const rack = rackSlotIn(d, insertId, slotId)?.rack;
  const branch = rack ? (findBranch(rack as Rack, branchId) as Draft<RackBranch> | undefined) : undefined;
  if (!branch) return false;
  if (settings.name !== undefined) branch.name = settings.name.trim().slice(0, RACK_NAME_MAX) || branch.name;
  if (settings.levelDb !== undefined && Number.isFinite(settings.levelDb))
    branch.levelDb = clampNumber(settings.levelDb, BRANCH_LEVEL_MIN_DB, BRANCH_LEVEL_MAX_DB);
  if (settings.pan !== undefined && Number.isFinite(settings.pan)) branch.pan = clampNumber(settings.pan, -1, 1);
  if (settings.muted !== undefined) branch.muted = settings.muted;
  if (settings.solo !== undefined) branch.solo = settings.solo;
  return true;
}

/** Moves one crossover of a `bands` rack, keeping it between its neighbours (and a little away from them). */
export function setCrossover(d: Draft<Project>, insertId: InsertId, slotId: SlotId, index: number, hz: number): boolean {
  const rack = rackSlotIn(d, insertId, slotId)?.rack;
  if (!rack || rack.split !== 'bands' || !Number.isFinite(hz) || index < 0 || index >= rack.crossovers.length) return false;
  const below = index === 0 ? CROSSOVER_MIN_HZ : (rack.crossovers[index - 1] as number) * CROSSOVER_MIN_RATIO;
  const above = index === rack.crossovers.length - 1 ? CROSSOVER_MAX_HZ : (rack.crossovers[index + 1] as number) / CROSSOVER_MIN_RATIO;
  rack.crossovers[index] = below > above ? below : clampNumber(hz, below, above);
  return true;
}

/** Sets every crossover of a `bands` rack at once (a snapshot recall); ignored unless the list fits the rack and is in order. */
export function setCrossovers(d: Draft<Project>, insertId: InsertId, slotId: SlotId, hz: readonly number[]): boolean {
  const rack = rackSlotIn(d, insertId, slotId)?.rack;
  if (!rack || rack.split !== 'bands' || hz.length !== rack.crossovers.length) return false;
  const isUsable = hz.every(
    (value, i) =>
      Number.isFinite(value) &&
      value >= CROSSOVER_MIN_HZ &&
      value <= CROSSOVER_MAX_HZ &&
      (i === 0 || value >= (hz[i - 1] as number) * CROSSOVER_MIN_RATIO),
  );
  if (!isUsable) return false;
  hz.forEach((value, i) => (rack.crossovers[i] = value));
  return true;
}

// ── Effects inside a rack ───────────────────────────────────────────────────────────────────────

/**
 * Adds an effect to the end (or `index`) of a branch. A rack cannot hold a rack. Returns the new effect's slot id, or null
 * when the branch is full or the rack, branch or plugin is not allowed.
 */
export function addRackFx(
  d: Draft<Project>,
  insertId: InsertId,
  slotId: SlotId,
  branchId: BranchId,
  plugin: PluginInstance,
  options: { index?: number; id?: SlotId } = {},
): SlotId | null {
  const insert = d.mixer.inserts[insertId];
  const rack = rackSlotIn(d, insertId, slotId)?.rack;
  const branch = rack?.branches.find((candidate) => candidate.id === branchId);
  const id = options.id ?? newId.slot();
  if (!insert || !branch || plugin.pluginId === RACK_PLUGIN_ID || branch.fx.length >= MAX_BRANCH_FX || locateSlot(insert, id)) return null;
  const at = options.index === undefined ? branch.fx.length : clampNumber(Math.round(options.index), 0, branch.fx.length);
  branch.fx.splice(at, 0, makeFxSlot(plugin, id) as Draft<FxSlot>);
  return id;
}

/** Removes an effect from its branch, with the mappings and controller links that pointed at it. */
export function removeRackFx(d: Draft<Project>, insertId: InsertId, effectId: SlotId): boolean {
  const found = locateSlot(d.mixer.inserts[insertId], effectId);
  if (!found?.rackSlot || !found.branch) return false;
  (found.branch.fx as Draft<FxSlot>[]).splice(found.index, 1);
  dropSlotLinks(d, insertId, [found.slot]);
  pruneMappings((found.rackSlot as RackSlotDraft).rack);
  return true;
}

/**
 * Moves an effect to a place in a branch of the same rack (another branch, or another place in its own). The effect keeps
 * its id, so its mappings, automation and the running instance stay with it.
 */
export function moveRackFx(
  d: Draft<Project>,
  insertId: InsertId,
  effectId: SlotId,
  toBranchId: BranchId,
  toIndex: number,
): boolean {
  const found = locateSlot(d.mixer.inserts[insertId], effectId);
  if (!found?.rackSlot || !found.branch) return false;
  const target = found.rackSlot.rack?.branches.find((branch) => branch.id === toBranchId);
  if (!target) return false;
  const isSameBranch = target === found.branch;
  if (!isSameBranch && target.fx.length >= MAX_BRANCH_FX) return false;
  const [slot] = (found.branch.fx as Draft<FxSlot>[]).splice(found.index, 1);
  if (!slot) return false;
  (target.fx as Draft<FxSlot>[]).splice(clampNumber(Math.round(toIndex), 0, target.fx.length), 0, slot);
  return true;
}

/** Moves an effect that is on the insert into a branch of one of the insert's racks. */
export function moveSlotIntoRack(
  d: Draft<Project>,
  insertId: InsertId,
  slotId: SlotId,
  rackSlotId: SlotId,
  branchId: BranchId,
  index?: number,
): RackEditResult {
  const insert = d.mixer.inserts[insertId];
  const rackSlot = rackSlotIn(d, insertId, rackSlotId);
  const from = insert?.fx.findIndex((slot) => slot.id === slotId) ?? -1;
  const slot = insert?.fx[from];
  const branch = rackSlot?.rack.branches.find((candidate) => candidate.id === branchId);
  if (!insert || !rackSlot || !slot || !branch) return { ok: false, reason: 'That effect or branch is gone.' };
  if (slot.rack) return { ok: false, reason: 'A rack cannot go inside another rack.' };
  if (slot.sidechain !== null) return { ok: false, reason: 'An effect with a sidechain input cannot go in a rack: clear its sidechain first.' };
  if (branch.fx.length >= MAX_BRANCH_FX) return { ok: false, reason: `A branch holds at most ${MAX_BRANCH_FX} effects.` };
  insert.fx.splice(from, 1);
  (branch.fx as Draft<FxSlot>[]).splice(index === undefined ? branch.fx.length : clampNumber(Math.round(index), 0, branch.fx.length), 0, slot);
  return { ok: true };
}

/** Moves an effect out of its rack onto the insert (at `toIndex` among the insert's slots, default after the rack). */
export function moveSlotOutOfRack(d: Draft<Project>, insertId: InsertId, effectId: SlotId, toIndex?: number): RackEditResult {
  const insert = d.mixer.inserts[insertId];
  const found = locateSlot(insert, effectId);
  if (!insert || !found?.rackSlot || !found.branch) return { ok: false, reason: 'That effect is not in a rack.' };
  if (insert.fx.length >= MAX_FX_SLOTS) return { ok: false, reason: `The track already has ${MAX_FX_SLOTS} effects.` };
  const [slot] = (found.branch.fx as Draft<FxSlot>[]).splice(found.index, 1);
  if (!slot) return { ok: false, reason: 'That effect is gone.' };
  const rackIndex = insert.fx.findIndex((candidate) => candidate.id === found.rackSlot?.id);
  const at = toIndex === undefined ? rackIndex + 1 : clampNumber(Math.round(toIndex), 0, insert.fx.length);
  insert.fx.splice(at, 0, slot);
  pruneMappings((found.rackSlot as RackSlotDraft).rack);
  return { ok: true };
}

// ── Macros ───────────────────────────────────────────────────────────────────────────────────

/** The values a mapping's range may take for each kind of target (a parameter's own range is applied by its spec). */
function clampToTarget(target: MacroTarget, value: number): number {
  switch (target.kind) {
    case 'mix':
      return clampNumber(value, 0, 1);
    case 'branch':
      return target.param === 'level' ? clampNumber(value, BRANCH_LEVEL_MIN_DB, BRANCH_LEVEL_MAX_DB) : clampNumber(value, -1, 1);
    case 'crossover':
      return clampNumber(value, CROSSOVER_MIN_HZ, CROSSOVER_MAX_HZ);
    case 'gain':
    case 'param':
      return value;
  }
}

/** Gives a macro a new name (empty keeps the old one). */
export function renameMacro(d: Draft<Project>, insertId: InsertId, slotId: SlotId, macroIndex: number, name: string): boolean {
  const macro = rackSlotIn(d, insertId, slotId)?.rack.macros[macroIndex];
  if (!macro) return false;
  macro.name = name.trim().slice(0, RACK_NAME_MAX) || macro.name;
  return true;
}

/**
 * Maps a macro to a target: adds the mapping, or replaces the macro's mapping of the same target. A target follows one macro
 * only, so any other macro's mapping of it goes. Returns false when the target is not in the rack, a number is not finite
 * or the macro already drives the most it can.
 */
export function setMacroMapping(
  d: Draft<Project>,
  insertId: InsertId,
  slotId: SlotId,
  macroIndex: number,
  mapping: MacroMapping,
): boolean {
  const rack = rackSlotIn(d, insertId, slotId)?.rack;
  const macro = rack?.macros[macroIndex];
  if (!rack || !macro || !Number.isFinite(mapping.min) || !Number.isFinite(mapping.max)) return false;
  if (!macroTargetExists(rack as Rack, mapping.target)) return false;
  const cleaned: MacroMapping = {
    target: { ...mapping.target },
    min: clampToTarget(mapping.target, mapping.min),
    max: clampToTarget(mapping.target, mapping.max),
    curve: mapping.curve,
  };
  for (const other of rack.macros) {
    if (other === macro) continue;
    other.mappings = other.mappings.filter((existing) => !sameMacroTarget(existing.target, cleaned.target));
  }
  const at = macro.mappings.findIndex((existing) => sameMacroTarget(existing.target, cleaned.target));
  if (at >= 0) macro.mappings[at] = cleaned;
  else if (macro.mappings.length >= MAX_MACRO_MAPPINGS) return false;
  else macro.mappings.push(cleaned);
  return true;
}

/** Takes one mapping off a macro. */
export function removeMacroMapping(d: Draft<Project>, insertId: InsertId, slotId: SlotId, macroIndex: number, target: MacroTarget): boolean {
  const macro = rackSlotIn(d, insertId, slotId)?.rack.macros[macroIndex];
  if (!macro) return false;
  const before = macro.mappings.length;
  macro.mappings = macro.mappings.filter((existing) => !sameMacroTarget(existing.target, target));
  return macro.mappings.length !== before;
}

/** Takes every mapping off a macro (its name stays). */
export function clearMacro(d: Draft<Project>, insertId: InsertId, slotId: SlotId, macroIndex: number): boolean {
  const macro = rackSlotIn(d, insertId, slotId)?.rack.macros[macroIndex];
  if (!macro) return false;
  macro.mappings = [];
  return true;
}
