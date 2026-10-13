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

type Inserts = Readonly<Record<InsertId, Insert>>;

export interface SoloState {
  /** A non-master insert is soloed. */
  readonly active: boolean;
  /** The soloed inserts themselves. */
  readonly soloed: ReadonlySet<InsertId>;
  /**
   * Inserts a solo leaves playing (every insert while nothing is soloed): the soloed ones, everything
   * routed into them (recursively: their sources play fully), everything they route to (recursively,
   * so they still reach the master) and the master.
   */
  readonly audible: ReadonlySet<InsertId>;
}

const soloCache = new WeakMap<object, SoloState>();
const mutedCache = new WeakMap<object, ReadonlySet<InsertId>>();

/**
 * FL's solo rule. Routes count; sidechains don't (the sidechain tap sits before the mute, so a
 * soloed track still ducks to a kick that the solo silences). Memoized by the inserts' identity.
 */
export function soloState(inserts: Inserts): SoloState {
  const cached = soloCache.get(inserts);
  if (cached) return cached;
  const list = Object.values(inserts);
  const soloed = new Set<InsertId>();
  for (const ins of list) if (ins.id !== MASTER && ins.solo) soloed.add(ins.id);
  let audible: Set<InsertId>;
  if (soloed.size === 0) audible = new Set(list.map((ins) => ins.id));
  else {
    const into = new Map<InsertId, InsertId[]>();
    for (const ins of list)
      for (const r of ins.routes) {
        if (!inserts[r.to] || r.to === ins.id) continue;
        const l = into.get(r.to);
        if (l) l.push(ins.id);
        else into.set(r.to, [ins.id]);
      }
    audible = new Set([MASTER]);
    const walk = (start: InsertId, next: (id: InsertId) => readonly InsertId[]) => {
      const stack = [start];
      const seen = new Set<InsertId>();
      while (stack.length) {
        const at = stack.pop()!;
        if (seen.has(at)) continue;
        seen.add(at);
        audible.add(at);
        stack.push(...next(at));
      }
    };
    for (const id of soloed) {
      walk(id, (at) => into.get(at) ?? []);
      walk(id, (at) => (inserts[at]?.routes ?? []).map((r) => r.to).filter((to) => !!inserts[to]));
    }
  }
  const state: SoloState = { active: soloed.size > 0, soloed, audible };
  soloCache.set(inserts, state);
  return state;
}

/**
 * Inserts that are silent because they are muted or because a solo leaves them out (see
 * `soloState`). The master is never silenced by a solo (only by its own mute).
 */
export function effectivelyMutedInserts(inserts: Inserts): ReadonlySet<InsertId> {
  const cached = mutedCache.get(inserts);
  if (cached) return cached;
  const solo = soloState(inserts);
  const out = new Set<InsertId>();
  for (const ins of Object.values(inserts)) {
    if (ins.muted || (solo.active && !solo.audible.has(ins.id))) out.add(ins.id);
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
