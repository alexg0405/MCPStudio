/**
 * Effect racks as the musician does them: put one on a track (empty, a factory rack or one you saved), group effects into one,
 * take it apart, save it, map a knob to a macro. Each is one undo step and says in a toast what it did or why it could not.
 */
import { MAX_FX_SLOTS } from '@core/ops/mixer';
import { addRackSlot, groupIntoRack, setMacroMapping, ungroupRack } from '@core/ops/racks';
import { isRackSlot } from '@core/model/rack';
import type { FxSlot, InsertId, MacroTarget, Rack, SlotId } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import { rackSlotOf } from '@core/query/rack';
import { rackSlotToFile } from '@core/rack/file';
import { buildChoice } from '../racks/build';
import type { RackChoice, UserRack } from '../racks/library';
import { rackChoices } from '../racks/library';
import { startingMapping } from '../racks/targets';
import type { Services } from '../services';

/** Every rack you can put on a track: the factory ones, then yours. */
export function allRacks(s: Services): RackChoice[] {
  return rackChoices(s.presets.racks());
}

/** Puts an empty rack (one branch, so it starts as a plain chain) on a track. Returns its slot id, or null when the track is full. */
export function addEmptyRack(s: Services, insertId: InsertId, index?: number): SlotId | null {
  let slotId: SlotId | null = null;
  s.history.transact('Add rack', (d) => {
    slotId = addRackSlot(d, insertId, index === undefined ? {} : { index });
  });
  if (!slotId) s.session.getState().toast(`${insertLabel(s.doc.getState().project, insertId)} already has ${MAX_FX_SLOTS} effects`, 'error');
  return slotId;
}

/** Puts a factory rack or one of yours on a track, as one undo step. Returns its slot id, or null (a toast says why). */
export function addRackChoice(s: Services, insertId: InsertId, choice: RackChoice, index?: number): SlotId | null {
  const project = s.doc.getState().project;
  const insert = project.mixer.inserts[insertId];
  if (!insert) return null;
  if (insert.fx.length >= MAX_FX_SLOTS) {
    s.session.getState().toast(`${insertLabel(project, insertId)} already has ${MAX_FX_SLOTS} effects`, 'error');
    return null;
  }
  const built = buildChoice(s, choice);
  if ('error' in built) {
    s.session.getState().toast(built.error, 'error');
    return null;
  }
  const slot = built.slot;
  s.history.transact(`Rack: ${choice.name}`, (d) => {
    const fx = d.mixer.inserts[insertId]?.fx;
    if (!fx) return;
    const at = index === undefined ? fx.length : Math.max(0, Math.min(index, fx.length));
    fx.splice(at, 0, slot as never);
  });
  s.session.getState().toast(`Put the rack “${choice.name}” on ${insertLabel(project, insertId)}`);
  return slot.id;
}

/** Puts the chosen effects of a track into one rack. Returns the rack's slot id, or null (a toast says why). */
export function groupSlotsIntoRack(s: Services, insertId: InsertId, slotIds: readonly SlotId[]): SlotId | null {
  let slotId: SlotId | null = null;
  let reason = '';
  s.history.transact('Group into a rack', (d) => {
    const result = groupIntoRack(d, insertId, slotIds);
    if (result.ok) slotId = result.slotId ?? null;
    else reason = result.reason;
  });
  if (!slotId) s.session.getState().toast(reason || 'Those effects could not go in a rack', 'error');
  return slotId;
}

/** Takes a rack apart: its effects go back on the track in its place. Returns whether it did (a toast says why not). */
export function ungroupSlot(s: Services, insertId: InsertId, slotId: SlotId): boolean {
  let reason = '';
  const done = s.history.transact('Ungroup rack', (d) => {
    const result = ungroupRack(d, insertId, slotId);
    if (!result.ok) reason = result.reason;
  });
  if (reason) s.session.getState().toast(reason, 'error');
  return done && !reason;
}

/** Saves a rack of a track as one of your racks (one of the same name is replaced). */
export function saveRackAs(s: Services, insertId: InsertId, slotId: SlotId, name: string, description?: string): UserRack | null {
  const slot = rackSlotOf(s.doc.getState().project, insertId, slotId);
  if (!slot) return null;
  return s.presets.saveRack(rackSlotToFile(slot, name, description));
}

/** The rack slot of a track, when it is one. */
export function rackAt(s: Services, insertId: InsertId, slotId: SlotId): (FxSlot & { rack: Rack }) | undefined {
  const slot = s.doc.getState().project.mixer.inserts[insertId]?.fx.find((candidate) => candidate.id === slotId);
  return slot && isRackSlot(slot) ? slot : undefined;
}

/**
 * Maps a macro to a target in one undo step, starting where the target is now (so nothing jumps while the macro sits at 0)
 * and sweeping the room the target has. Returns false when the target cannot be found.
 */
export function mapToMacro(s: Services, insertId: InsertId, slotId: SlotId, macroIndex: number, target: MacroTarget): boolean {
  const slot = rackAt(s, insertId, slotId);
  const mapping = slot ? startingMapping(s, slot, target) : null;
  if (!mapping) return false;
  return s.history.transact('Map to macro', (d) => void setMacroMapping(d, insertId, slotId, macroIndex, mapping));
}
