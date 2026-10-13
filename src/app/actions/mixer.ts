import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type ChannelId, type InsertId, type PluginInstance, type SlotId } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import {
  addFxSlot,
  addInsert,
  MAX_FX_SLOTS,
  moveFxSlot,
  moveInsert,
  removeFxSlot,
  removeInsert,
  replaceFxPlugin,
  setFxSlotEnabled,
} from '@core/ops/mixer';
import { fxSlotOf, insertLabel } from '@core/query/mixer';
import { defaultValues } from '@agstudio/sdk';
import type { Services } from '../services';

// User-level mixer actions: each is one undoable edit, used by the mixer, menus and the browser.

/** Fresh plugin data (default params) for an effect, or null if the id isn't an installed effect. */
function effectData(s: Services, pluginId: string): { name: string; data: PluginInstance } | null {
  const def = s.plugins.get(pluginId);
  if (!def || def.kind !== 'effect') return null;
  return { name: def.name, data: makePluginInstance(def.id, def.version, defaultValues(def.params)) };
}

/** Adds an effect to an insert (after its last effect by default). Returns the new slot, or null. */
export function addEffect(s: Services, insertId: InsertId, pluginId: string, index?: number): SlotId | null {
  const fx = effectData(s, pluginId);
  const insert = s.doc.getState().project.mixer.inserts[insertId];
  if (!fx || !insert || insert.fx.length >= MAX_FX_SLOTS) return null;
  const id = newId.slot();
  let added: SlotId | null = null;
  s.history.transact(`Add ${fx.name}`, (d) => {
    added = addFxSlot(d, insertId, fx.data, index, id);
  });
  return added;
}

/**
 * Adds an effect to the insert selected in the mixer (the master when none is), e.g. from the
 * browser. Tells the user when the insert is full.
 */
export function addEffectToSelectedInsert(
  s: Services,
  pluginId: string,
): { insertId: InsertId; slotId: SlotId } | null {
  const project = s.doc.getState().project;
  const selected = s.session.getState().selectedInsertId;
  const insertId = selected && project.mixer.inserts[selected] ? selected : MASTER;
  const slotId = addEffect(s, insertId, pluginId);
  if (!slotId) {
    const full = (project.mixer.inserts[insertId]?.fx.length ?? 0) >= MAX_FX_SLOTS;
    if (full) s.session.getState().toast(`${insertLabel(project, insertId)} has no free effect slot`, 'error');
    return null;
  }
  return { insertId, slotId };
}

/** Puts a different effect (default settings) into an existing slot. */
export function replaceEffect(s: Services, insertId: InsertId, slotId: SlotId, pluginId: string): boolean {
  const fx = effectData(s, pluginId);
  if (!fx || !fxSlotOf(s.doc.getState().project, insertId, slotId)) return false;
  return s.history.transact(`Replace with ${fx.name}`, (d) => replaceFxPlugin(d, insertId, slotId, fx.data));
}

export function removeEffect(s: Services, insertId: InsertId, slotId: SlotId): void {
  const slot = fxSlotOf(s.doc.getState().project, insertId, slotId);
  if (!slot) return;
  const name = s.plugins.get(slot.plugin.pluginId)?.name ?? 'effect';
  s.history.transact(`Remove ${name}`, (d) => removeFxSlot(d, insertId, slotId));
}

export function moveEffectBy(s: Services, insertId: InsertId, slotId: SlotId, delta: number): void {
  const fx = s.doc.getState().project.mixer.inserts[insertId]?.fx ?? [];
  const i = fx.findIndex((x) => x.id === slotId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= fx.length) return;
  s.history.transact('Move effect', (d) => moveFxSlot(d, insertId, slotId, j));
}

export function toggleEffect(s: Services, insertId: InsertId, slotId: SlotId): void {
  const slot = fxSlotOf(s.doc.getState().project, insertId, slotId);
  if (!slot) return;
  const name = s.plugins.get(slot.plugin.pluginId)?.name ?? 'effect';
  s.history.transact(`${slot.enabled ? 'Bypass' : 'Enable'} ${name}`, (d) =>
    setFxSlotEnabled(d, insertId, slotId, !slot.enabled),
  );
}

/** Adds an insert after position `after` (default: at the end), named by its number, and selects it. */
export function addMixerInsert(s: Services, after?: number): InsertId {
  const order = s.doc.getState().project.mixer.order;
  const at = after === undefined ? order.length : Math.max(1, Math.min(after + 1, order.length));
  const insert = makeInsert(newId.insert(), `Insert ${at}`);
  s.history.transact('Add insert', (d) => addInsert(d, insert, at));
  s.session.getState().selectInsert(insert.id);
  return insert.id;
}

/** Deletes an insert (not the master); its channels go to the master. */
export function deleteInsert(s: Services, insertId: InsertId): void {
  const project = s.doc.getState().project;
  if (insertId === MASTER || !project.mixer.inserts[insertId]) return;
  const name = project.mixer.inserts[insertId]?.name ?? insertLabel(project, insertId);
  s.history.transact(`Delete ${name}`, (d) => removeInsert(d, insertId));
}

export function moveInsertBy(s: Services, insertId: InsertId, delta: number): void {
  const order = s.doc.getState().project.mixer.order;
  const i = order.indexOf(insertId);
  const j = i + delta;
  if (i < 1 || j < 1 || j >= order.length) return;
  s.history.transact('Move insert', (d) => moveInsert(d, insertId, j));
}

/** Routes a channel to an insert (FL: "link selected channel to this track"). */
export function routeChannel(s: Services, channelId: ChannelId, insertId: InsertId): void {
  const project = s.doc.getState().project;
  const ch = project.channels[channelId];
  if (!ch || ch.kind === 'automation' || !project.mixer.inserts[insertId] || ch.output === insertId) return;
  s.history.transact(`Route ${ch.name} to ${insertLabel(project, insertId)}`, (d) =>
    setChannelProp(d, channelId, 'output', insertId),
  );
}
