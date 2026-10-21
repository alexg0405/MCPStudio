/**
 * Reading effect racks. An effect inside a rack is an ordinary `FxSlot` with an id that is unique in its insert, so
 * everything that looks a slot up by `{ insertId, slotId }` can find it with `locateSlot`.
 */
import type {
  BranchId,
  InsertId,
  ParamTarget,
  FxSlot,
  Insert,
  MacroTarget,
  Project,
  Rack,
  RackBranch,
  SlotId,
} from '../model/types';
import type { PluginInfoResolver } from '../automation/labels';
import { isRackSlot, macroIndexOfParam, sameMacroTarget } from '../model/rack';

/** Where a slot sits: on the insert itself, or in a branch of a rack slot on it. */
export interface SlotLocation {
  slot: FxSlot;
  /** The rack slot it is inside; null for a slot on the insert. */
  rackSlot: FxSlot | null;
  /** The branch it is in; null for a slot on the insert. */
  branch: RackBranch | null;
  /** Its place in the insert's slot list, or in the branch's effects. */
  index: number;
}

/** Finds a slot on the insert or inside one of its racks. */
export function locateSlot(insert: Insert | undefined, slotId: SlotId): SlotLocation | undefined {
  if (!insert) return undefined;
  for (let index = 0; index < insert.fx.length; index++) {
    const slot = insert.fx[index] as FxSlot;
    if (slot.id === slotId) return { slot, rackSlot: null, branch: null, index };
    if (!slot.rack) continue;
    for (const branch of slot.rack.branches) {
      const inner = branch.fx.findIndex((candidate) => candidate.id === slotId);
      if (inner >= 0) return { slot: branch.fx[inner] as FxSlot, rackSlot: slot, branch, index: inner };
    }
  }
  return undefined;
}

/** Every slot of the insert in order: each slot on the insert, followed by the effects inside it when it is a rack. */
export function allSlots(insert: Insert): FxSlot[] {
  const out: FxSlot[] = [];
  for (const slot of insert.fx) {
    out.push(slot);
    for (const inner of innerSlots(slot)) out.push(inner);
  }
  return out;
}

/** The effects inside a rack slot, branch by branch (none for any other slot). */
export function innerSlots(slot: FxSlot): FxSlot[] {
  return slot.rack ? slot.rack.branches.flatMap((branch) => branch.fx) : [];
}

/** A rack slot of an insert by id, or undefined when the slot is missing or is not a rack. */
export function rackSlotOf(project: Project, insertId: Insert['id'], slotId: SlotId): (FxSlot & { rack: Rack }) | undefined {
  const slot = project.mixer.inserts[insertId]?.fx.find((candidate) => candidate.id === slotId);
  return slot && isRackSlot(slot) ? slot : undefined;
}

/** A branch of a rack by id. */
export function findBranch(rack: Rack, branchId: BranchId): RackBranch | undefined {
  return rack.branches.find((branch) => branch.id === branchId);
}

/** Whether the target still exists in the rack (its effect, its branch, its crossover). */
export function macroTargetExists(rack: Rack, target: MacroTarget): boolean {
  switch (target.kind) {
    case 'param':
    case 'mix':
      return rack.branches.some((branch) => branch.fx.some((slot) => slot.id === target.slotId));
    case 'branch':
      return rack.branches.some((branch) => branch.id === target.branchId);
    case 'crossover':
      return rack.split === 'bands' && target.index >= 0 && target.index < rack.crossovers.length;
    case 'gain':
      return true;
  }
}

/**
 * The branches that sound: with any branch soloed, only the soloed ones; otherwise the ones that are not muted.
 * (Muting and soloing never change the rack's latency, so the branches that are left stay in time.)
 */
export function audibleBranches(rack: Rack): ReadonlySet<BranchId> {
  const soloed = rack.branches.filter((branch) => branch.solo);
  const audible = soloed.length > 0 ? soloed : rack.branches.filter((branch) => !branch.muted);
  return new Set(audible.map((branch) => branch.id));
}

/** The plugin ids of every effect inside the rack slots of an insert (for "which plugins does this project need"). */
export function innerPluginIds(insert: Insert): string[] {
  return insert.fx.flatMap((slot) => innerSlots(slot).map((inner) => inner.plugin.pluginId));
}

/** The name the musician gave a macro, when `paramId` is one of the macro knobs of this rack slot (null otherwise). */
export function macroNameOf(slot: FxSlot, paramId: string): string | null {
  const index = macroIndexOfParam(paramId);
  return index >= 0 && slot.rack ? (slot.rack.macros[index]?.name ?? null) : null;
}

/**
 * What a macro target is, in plain words: "Squashed · Compressor · Threshold", "Squashed · Level", "Crossover 1",
 * "Rack output". Null when the target is not in the rack. `plugins` gives an effect's name and parameter labels.
 */
export function describeMacroTarget(rack: Rack, target: MacroTarget, plugins: PluginInfoResolver): string | null {
  if (!macroTargetExists(rack, target)) return null;
  switch (target.kind) {
    case 'param':
    case 'mix': {
      const branch = rack.branches.find((candidate) => candidate.fx.some((slot) => slot.id === target.slotId));
      const slot = branch?.fx.find((candidate) => candidate.id === target.slotId);
      const info = slot ? plugins(slot.plugin.pluginId) : undefined;
      const what = target.kind === 'mix' ? 'Dry/wet' : (info?.params[target.paramId]?.label ?? target.paramId);
      return `${branch?.name ?? 'Branch'} · ${info?.name ?? 'Effect'} · ${what}`;
    }
    case 'branch': {
      const branch = rack.branches.find((candidate) => candidate.id === target.branchId);
      return `${branch?.name ?? 'Branch'} · ${target.param === 'level' ? 'Level' : 'Pan'}`;
    }
    case 'crossover':
      return `Crossover ${target.index + 1}`;
    case 'gain':
      return 'Rack output';
  }
}

/** The macro that moves a control, when it is mapped to one: which rack, which macro and what the musician called it. */
export interface MacroDriver {
  insertId: InsertId;
  rackSlotId: SlotId;
  /** 0-based. */
  macro: number;
  name: string;
}

/** A control that a rack's macro can move: the rack it is in and what it is called there. */
export interface RackControl {
  insertId: InsertId;
  rackSlot: FxSlot & { rack: Rack };
  macroTarget: MacroTarget;
}

/** The macro target a control is, when it is something a rack's macro can move (an effect in a rack, its mix, a rack's output). */
function macroTargetOfControl(insert: Insert, target: ParamTarget): { rackSlot: FxSlot & { rack: Rack }; macroTarget: MacroTarget } | null {
  if (target.kind === 'plugin' && target.owner.kind === 'fx') {
    const found = locateSlot(insert, target.owner.slotId);
    if (!found) return null;
    if (found.rackSlot && isRackSlot(found.rackSlot)) {
      return { rackSlot: found.rackSlot, macroTarget: { kind: 'param', slotId: found.slot.id, paramId: target.paramId } };
    }
    if (isRackSlot(found.slot) && target.paramId === 'gain') return { rackSlot: found.slot, macroTarget: { kind: 'gain' } };
    return null;
  }
  if (target.kind === 'slot') {
    const found = locateSlot(insert, target.slotId);
    if (found?.rackSlot && isRackSlot(found.rackSlot)) return { rackSlot: found.rackSlot, macroTarget: { kind: 'mix', slotId: found.slot.id } };
  }
  return null;
}

/** The insert a control of an effect belongs to (null for any other control). */
function insertOfControl(target: ParamTarget): InsertId | null {
  if (target.kind === 'plugin') return target.owner.kind === 'fx' ? target.owner.insertId : null;
  return target.kind === 'slot' ? target.insertId : null;
}

/** The rack control a parameter target is (an effect's setting or dry/wet inside a rack, a rack's output), or null for any other. */
export function rackControlOf(project: Project, target: ParamTarget): RackControl | null {
  const insertId = insertOfControl(target);
  const insert = insertId ? project.mixer.inserts[insertId] : undefined;
  const control = insert ? macroTargetOfControl(insert, target) : null;
  return insertId && control ? { insertId, ...control } : null;
}

/** The macro that moves the control, or null when none does. */
export function macroDriving(project: Project, target: ParamTarget): MacroDriver | null {
  const control = rackControlOf(project, target);
  if (!control) return null;
  const { insertId } = control;
  const index = control.rackSlot.rack.macros.findIndex((macro) =>
    macro.mappings.some((mapping) => sameMacroTarget(mapping.target, control.macroTarget)),
  );
  if (index < 0) return null;
  return { insertId, rackSlotId: control.rackSlot.id, macro: index, name: control.rackSlot.rack.macros[index]?.name ?? `Macro ${index + 1}` };
}
