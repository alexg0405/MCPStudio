/**
 * Copying a rack: the copy gets new ids for the rack slot, every effect inside and every branch (ids must stay unique in
 * an insert), and its macro mappings are pointed at the new ids.
 */
import { newId } from '../model/ids';
import type { BranchId, FxSlot, MacroMapping, MacroTarget, Rack, SlotId } from '../model/types';

/** A deep copy of a plain JSON-like value (a slot is nothing else). */
function copyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The target of a mapping after ids were renamed; targets that did not move are copied as they are. */
function retarget(target: MacroTarget, slots: ReadonlyMap<SlotId, SlotId>, branches: ReadonlyMap<BranchId, BranchId>): MacroTarget {
  switch (target.kind) {
    case 'param':
      return { ...target, slotId: slots.get(target.slotId) ?? target.slotId };
    case 'mix':
      return { ...target, slotId: slots.get(target.slotId) ?? target.slotId };
    case 'branch':
      return { ...target, branchId: branches.get(target.branchId) ?? target.branchId };
    default:
      return { ...target };
  }
}

/** Gives the rack's effects and branches new ids, and points the mappings at them. Edits the rack in place. */
function renewRackIds(rack: Rack): void {
  const slots = new Map<SlotId, SlotId>();
  const branches = new Map<BranchId, BranchId>();
  for (const branch of rack.branches) {
    const id = newId.branch();
    branches.set(branch.id, id);
    branch.id = id;
    for (const slot of branch.fx) {
      const renamed = newId.slot();
      slots.set(slot.id, renamed);
      slot.id = renamed;
    }
  }
  for (const macro of rack.macros) {
    macro.mappings = macro.mappings.map((mapping): MacroMapping => ({ ...mapping, target: retarget(mapping.target, slots, branches) }));
  }
}

/** A copy of a slot with new ids all through. Any slot works; a rack's effects and branches are renewed too. */
export function cloneSlotWithNewIds(slot: FxSlot): FxSlot {
  const copy = copyOf(slot);
  copy.id = newId.slot();
  if (copy.rack) renewRackIds(copy.rack);
  return copy;
}
