import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import {
  MASTER,
  type ChannelId,
  type InsertId,
  type PluginInstance,
  type Project,
  type SlotId,
} from '@core/model/types';
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
import { clearRoutes, removeRoute, routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import { fxSlotOf, insertLabel } from '@core/query/mixer';
import { canRoute, wouldCycle } from '@core/query/routing';
import { defaultValues } from '@agstudio/sdk';
import type { Services } from '../services';
import { presetValues, type PresetChoice } from '../presets';

// User-level mixer actions: each is one undoable edit, used by the mixer, menus and the browser.

/** Fresh plugin data (default params, or a preset's) for an effect, or null if the id isn't an installed effect. */
function effectData(s: Services, pluginId: string, preset?: PresetChoice): { name: string; data: PluginInstance } | null {
  const def = s.plugins.get(pluginId);
  if (!def || def.kind !== 'effect') return null;
  if (!preset) return { name: def.name, data: makePluginInstance(def.id, def.version, defaultValues(def.params)) };
  const { params, state } = presetValues(def, preset);
  return {
    name: `${def.name}: ${preset.name}`,
    data: makePluginInstance(def.id, def.version, params, state !== undefined ? { state } : {}),
  };
}

/** Adds an effect to an insert (after its last effect by default). Returns the new slot, or null. */
export function addEffect(
  s: Services,
  insertId: InsertId,
  pluginId: string,
  index?: number,
  preset?: PresetChoice,
): SlotId | null {
  const fx = effectData(s, pluginId, preset);
  const insert = s.doc.getState().project.mixer.inserts[insertId];
  if (!fx || !insert || insert.fx.length >= MAX_FX_SLOTS) return null;
  const id = newId.slot();
  let added: SlotId | null = null;
  s.history.transact(`Add ${fx.name}`, (d) => {
    added = addFxSlot(d, insertId, fx.data, index, id);
  });
  if (added && preset) s.presets.noteLoaded({ kind: 'fx', insertId, slotId: added }, preset.name);
  return added;
}

/**
 * Adds an effect to the insert selected in the mixer (the master when none is), e.g. from the
 * browser. Tells the user when the insert is full.
 */
export function addEffectToSelectedInsert(
  s: Services,
  pluginId: string,
  preset?: PresetChoice,
): { insertId: InsertId; slotId: SlotId } | null {
  const project = s.doc.getState().project;
  const selected = s.session.getState().selectedInsertId;
  const insertId = selected && project.mixer.inserts[selected] ? selected : MASTER;
  const slotId = addEffect(s, insertId, pluginId, undefined, preset);
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

// ---- Routing (each is one undoable edit; impossible ones, such as loops, are refused) ----

/** What people call an insert in undo labels: its name ("Kick"), or "Master". */
function trackName(project: Project, id: InsertId): string {
  return id === MASTER ? 'Master' : (project.mixer.inserts[id]?.name ?? insertLabel(project, id));
}

/** FL's send arrow: adds the route from → to (unity, post-fader) or removes it. */
export function toggleRoute(s: Services, from: InsertId, to: InsertId): boolean {
  const project = s.doc.getState().project;
  const src = project.mixer.inserts[from];
  if (!src || !project.mixer.inserts[to]) return false;
  const label = `${trackName(project, from)} to ${trackName(project, to)}`;
  if (src.routes.some((r) => r.to === to))
    return s.history.transact(`Stop sending ${label}`, (d) => removeRoute(d, from, to));
  if (!canRoute(project.mixer, from, to)) return false;
  let ok = false;
  s.history.transact(`Send ${label}`, (d) => {
    ok = setRoute(d, from, to);
  });
  return ok;
}

/** FL's "Route to this track only": `to` becomes the insert's only route. */
export function routeOnly(s: Services, from: InsertId, to: InsertId): boolean {
  const project = s.doc.getState().project;
  if (!project.mixer.inserts[from] || !canRoute(project.mixer, from, to)) return false;
  let ok = false;
  s.history.transact(`Route ${trackName(project, from)} only to ${trackName(project, to)}`, (d) => {
    ok = routeOnlyTo(d, from, to);
  });
  return ok;
}

/** Takes the send from → to before (pre) or after the source's pan and fader. */
export function setRoutePre(s: Services, from: InsertId, to: InsertId, pre: boolean): void {
  const project = s.doc.getState().project;
  if (!project.mixer.inserts[from]?.routes.some((r) => r.to === to)) return;
  const label = `${trackName(project, from)} to ${trackName(project, to)}`;
  s.history.transact(`Send ${label} ${pre ? 'before' : 'after'} the fader`, (d) => {
    setRoute(d, from, to, { pre });
  });
}

/** Removes every route of the insert (it falls silent). */
export function removeAllRoutes(s: Services, id: InsertId): void {
  const project = s.doc.getState().project;
  if (!project.mixer.inserts[id]?.routes.length) return;
  s.history.transact(`Remove all sends of ${trackName(project, id)}`, (d) => clearRoutes(d, id));
}

/** Feeds the slot's sidechain input from `source` (null: the effect keys from its own input). */
export function setSidechain(s: Services, insertId: InsertId, slotId: SlotId, source: InsertId | null): boolean {
  const project = s.doc.getState().project;
  const slot = fxSlotOf(project, insertId, slotId);
  if (!slot || slot.sidechain === source) return false;
  const name = s.plugins.get(slot.plugin.pluginId)?.name ?? 'effect';
  let ok = false;
  s.history.transact(
    source ? `Sidechain ${name} from ${trackName(project, source)}` : `${name} listens to its own input`,
    (d) => {
      ok = setSlotSidechain(d, insertId, slotId, source);
    },
  );
  return ok;
}

/** Adds an effect to `insertId` keyed by `source`, in one step (FL's "Sidechain to this track"). */
export function addSidechainEffect(s: Services, insertId: InsertId, pluginId: string, source: InsertId): SlotId | null {
  const fx = effectData(s, pluginId);
  const project = s.doc.getState().project;
  const insert = project.mixer.inserts[insertId];
  if (!fx || !insert || insert.fx.length >= MAX_FX_SLOTS || !project.mixer.inserts[source]) return null;
  if (wouldCycle(project.mixer.inserts, source, insertId)) return null;
  const id = newId.slot();
  let added: SlotId | null = null;
  s.history.transact(`Add ${fx.name} reacting to ${trackName(project, source)}`, (d) => {
    added = addFxSlot(d, insertId, fx.data, undefined, id);
    if (added) setSlotSidechain(d, insertId, added, source);
  });
  return added;
}
