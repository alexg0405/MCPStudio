import type { Draft } from 'immer';
import { MAX_INSERT_VOLUME } from '../model/fader';
import { newId } from '../model/ids';
import {
  MASTER,
  type FxSlot,
  type Insert,
  type InsertId,
  type PluginInstance,
  type Project,
  type SlotId,
} from '../model/types';
import { retargetChannels } from './channels';

// Pure draft mutators for the mixer. Call them inside history.transact()/gesture() recipes.

/** FL gives every insert ten effect slots. */
export const MAX_FX_SLOTS = 10;

export type InsertProp = 'name' | 'color' | 'volume' | 'pan' | 'muted' | 'solo';
type InsertPropValue = {
  name: string;
  /** undefined (or '') removes the colour. */
  color: string | undefined;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};

export function setInsertProp<K extends InsertProp>(
  d: Draft<Project>,
  id: InsertId,
  prop: K,
  value: InsertPropValue[K],
): void {
  const ins = d.mixer.inserts[id];
  if (!ins) return;
  switch (prop) {
    case 'volume':
      ins.volume = clamp(value as number, 0, MAX_INSERT_VOLUME);
      return;
    case 'pan':
      ins.pan = clamp(value as number, -1, 1, 0);
      return;
    case 'muted':
      ins.muted = Boolean(value);
      return;
    case 'solo':
      // The master always plays; soloing it means nothing.
      ins.solo = id !== MASTER && Boolean(value);
      return;
    case 'name':
      ins.name = String(value).trim().slice(0, 64) || ins.name;
      return;
    case 'color':
      if (value) ins.color = String(value);
      else delete ins.color;
      return;
  }
}

/**
 * FL-style exclusive solo among the non-master inserts: soloing an insert silences every other
 * insert (the master keeps playing, so channels routed straight to it stay audible); soloing the
 * insert that is already the only solo clears the solo.
 */
export function toggleSoloInsert(d: Draft<Project>, id: InsertId): void {
  if (id === MASTER) return;
  const target = d.mixer.inserts[id];
  if (!target) return;
  const others = Object.values(d.mixer.inserts).filter((ins) => ins.id !== MASTER);
  const wasOnlySolo = target.solo && others.every((ins) => ins.id === id || !ins.solo);
  for (const ins of others) {
    ins.solo = wasOnlySolo ? false : ins.id === id;
    if (ins.id === id && !wasOnlySolo) ins.muted = false;
  }
}

/** Adds an insert at `index` in the mixer order (never before the master; default: at the end). */
export function addInsert(d: Draft<Project>, insert: Insert, index?: number): void {
  if (insert.id === MASTER || d.mixer.inserts[insert.id]) return;
  d.mixer.inserts[insert.id] = insert as Draft<Insert>;
  const order = d.mixer.order;
  const at = index === undefined ? order.length : Math.max(1, Math.min(Math.round(index), order.length));
  order.splice(at, 0, insert.id);
}

/** Removes an insert (never the master); channels that played through it go to the master. */
export function removeInsert(d: Draft<Project>, id: InsertId): void {
  if (id === MASTER || !d.mixer.inserts[id]) return;
  delete d.mixer.inserts[id];
  const i = d.mixer.order.indexOf(id);
  if (i >= 0) d.mixer.order.splice(i, 1);
  retargetChannels(d, id);
}

/** Moves an insert to `toIndex` in the final order (the master stays first). */
export function moveInsert(d: Draft<Project>, id: InsertId, toIndex: number): void {
  if (id === MASTER) return;
  const order = d.mixer.order;
  const from = order.indexOf(id);
  if (from < 1) return;
  const to = Math.max(1, Math.min(Math.round(toIndex), order.length - 1));
  if (to === from) return;
  order.splice(from, 1);
  order.splice(to, 0, id);
}

function slotsOf(d: Draft<Project>, insertId: InsertId) {
  return d.mixer.inserts[insertId]?.fx;
}

function slotOf(d: Draft<Project>, insertId: InsertId, slotId: SlotId) {
  return slotsOf(d, insertId)?.find((s) => s.id === slotId);
}

/**
 * Adds an effect slot (enabled, fully wet) at `index` (default: after the last one). Slots have no
 * gaps and an insert holds at most MAX_FX_SLOTS. Returns the new slot's id, or null if it wasn't added.
 */
export function addFxSlot(
  d: Draft<Project>,
  insertId: InsertId,
  plugin: PluginInstance,
  index?: number,
  id: SlotId = newId.slot(),
): SlotId | null {
  const fx = slotsOf(d, insertId);
  if (!fx || fx.length >= MAX_FX_SLOTS || fx.some((s) => s.id === id)) return null;
  const slot: FxSlot = { id, plugin, enabled: true, mix: 1 };
  const at = index === undefined ? fx.length : Math.max(0, Math.min(Math.round(index), fx.length));
  fx.splice(at, 0, slot as Draft<FxSlot>);
  return id;
}

export function removeFxSlot(d: Draft<Project>, insertId: InsertId, slotId: SlotId): void {
  const fx = slotsOf(d, insertId);
  const i = fx?.findIndex((s) => s.id === slotId) ?? -1;
  if (fx && i >= 0) fx.splice(i, 1);
}

/** Moves a slot within its insert; the slot keeps its id (and the engine keeps its instance). */
export function moveFxSlot(d: Draft<Project>, insertId: InsertId, slotId: SlotId, toIndex: number): void {
  const fx = slotsOf(d, insertId);
  if (!fx) return;
  const from = fx.findIndex((s) => s.id === slotId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(Math.round(toIndex), fx.length - 1));
  if (to === from) return;
  const [slot] = fx.splice(from, 1);
  if (slot) fx.splice(to, 0, slot);
}

export function setFxSlotEnabled(d: Draft<Project>, insertId: InsertId, slotId: SlotId, enabled: boolean): void {
  const slot = slotOf(d, insertId, slotId);
  if (slot) slot.enabled = Boolean(enabled);
}

/** Dry/wet of the slot, 0–1. */
export function setFxSlotMix(d: Draft<Project>, insertId: InsertId, slotId: SlotId, mix: number): void {
  const slot = slotOf(d, insertId, slotId);
  if (slot) slot.mix = clamp(mix, 0, 1, 1);
}

/** Puts a different effect (or a fresh instance of the same one) in an existing slot. */
export function replaceFxPlugin(d: Draft<Project>, insertId: InsertId, slotId: SlotId, plugin: PluginInstance): void {
  const slot = slotOf(d, insertId, slotId);
  if (slot) slot.plugin = plugin as Draft<PluginInstance>;
}

function clamp(v: number, lo: number, hi: number, fallback = lo): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}
