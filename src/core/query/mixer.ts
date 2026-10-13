/**
 * Mixer queries shared by the engine and the UI (memoized by the identity of immutable inputs).
 */
import {
  MASTER,
  type FxSlot,
  type Insert,
  type InsertId,
  type PluginInstance,
  type PluginOwner,
  type Project,
} from '../model/types';

const mutedCache = new WeakMap<object, ReadonlySet<InsertId>>();

/**
 * Inserts that are silent because they are muted or because another non-master insert is soloed.
 * The master is never silenced by a solo (only by its own mute).
 */
export function effectivelyMutedInserts(inserts: Readonly<Record<InsertId, Insert>>): ReadonlySet<InsertId> {
  const cached = mutedCache.get(inserts);
  if (cached) return cached;
  const list = Object.values(inserts);
  const anySolo = list.some((ins) => ins.id !== MASTER && ins.solo);
  const out = new Set<InsertId>();
  for (const ins of list) {
    if (ins.muted || (anySolo && ins.id !== MASTER && !ins.solo)) out.add(ins.id);
  }
  mutedCache.set(inserts, out);
  return out;
}

/** An effect slot by id. */
export function fxSlotOf(project: Project, insertId: InsertId, slotId: FxSlot['id']): FxSlot | undefined {
  return project.mixer.inserts[insertId]?.fx.find((s) => s.id === slotId);
}

/** The plugin data a plugin owner refers to: a channel's instrument or an insert slot's effect. */
export function pluginInstanceOf(project: Project, owner: PluginOwner): PluginInstance | undefined {
  if (owner.kind === 'channel') {
    const ch = project.channels[owner.channelId];
    return ch?.kind === 'instrument' ? ch.plugin : undefined;
  }
  return fxSlotOf(project, owner.insertId, owner.slotId)?.plugin;
}

/** "Master" or "Insert N" (an insert's number is its position in the mixer). */
export function insertLabel(project: Project, id: InsertId): string {
  if (id === MASTER) return 'Master';
  const i = project.mixer.order.indexOf(id);
  return i > 0 ? `Insert ${i}` : (project.mixer.inserts[id]?.name ?? 'Insert');
}
