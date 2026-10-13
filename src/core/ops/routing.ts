import type { Draft } from 'immer';
import { MAX_INSERT_VOLUME } from '../model/fader';
import { MASTER, type InsertId, type Project, type SlotId } from '../model/types';
import { wouldCycle } from '../query/routing';

// Pure draft mutators for mixer routing. Edits that would make audio loop are refused (return false).

/** Adds or updates the route from → to. */
export function setRoute(
  d: Draft<Project>,
  from: InsertId,
  to: InsertId,
  opts: { level?: number; pre?: boolean } = {},
): boolean {
  const src = d.mixer.inserts[from];
  if (from === MASTER || !src || !d.mixer.inserts[to]) return false;
  const existing = src.routes.find((r) => r.to === to);
  if (!existing && wouldCycle(d.mixer.inserts, from, to)) return false;
  const level = clampLevel(opts.level ?? existing?.level ?? 1);
  const pre = opts.pre ?? existing?.pre ?? false;
  if (existing) Object.assign(existing, { level, pre });
  else src.routes.push({ to, level, pre });
  return true;
}

export function removeRoute(d: Draft<Project>, from: InsertId, to: InsertId): void {
  const src = d.mixer.inserts[from];
  if (!src) return;
  const i = src.routes.findIndex((r) => r.to === to);
  if (i >= 0) src.routes.splice(i, 1);
}

/** FL's "Route to this track only": the insert's only route becomes `to` (post-fader, unity). */
export function routeOnlyTo(d: Draft<Project>, from: InsertId, to: InsertId): boolean {
  const src = d.mixer.inserts[from];
  if (from === MASTER || !src || !d.mixer.inserts[to] || from === to) return false;
  const saved = src.routes.splice(0);
  if (wouldCycle(d.mixer.inserts, from, to)) {
    src.routes.push(...saved);
    return false;
  }
  src.routes.push({ to, level: 1, pre: false });
  return true;
}

/** Removes every route of the insert (with no route it falls silent). */
export function clearRoutes(d: Draft<Project>, id: InsertId): void {
  d.mixer.inserts[id]?.routes.splice(0);
}

export function setRouteLevel(d: Draft<Project>, from: InsertId, to: InsertId, level: number): void {
  const r = d.mixer.inserts[from]?.routes.find((x) => x.to === to);
  if (r) r.level = clampLevel(level);
}

/** Feeds the slot's sidechain input from `source` (null disconnects it). */
export function setSlotSidechain(
  d: Draft<Project>,
  insertId: InsertId,
  slotId: SlotId,
  source: InsertId | null,
): boolean {
  const slot = d.mixer.inserts[insertId]?.fx.find((s) => s.id === slotId);
  if (!slot) return false;
  if (source === null) {
    slot.sidechain = null;
    return true;
  }
  if (!d.mixer.inserts[source] || (slot.sidechain !== source && wouldCycle(d.mixer.inserts, source, insertId)))
    return false;
  slot.sidechain = source;
  return true;
}

/**
 * After an insert is deleted: routes to it go (an insert left with no route at all goes to the
 * master instead of falling silent) and sidechains it fed are cleared.
 */
export function dropRoutesTo(d: Draft<Project>, id: InsertId): void {
  for (const ins of Object.values(d.mixer.inserts)) {
    const i = ins.routes.findIndex((r) => r.to === id);
    if (i >= 0) {
      ins.routes.splice(i, 1);
      if (ins.routes.length === 0 && ins.id !== MASTER) ins.routes.push({ to: MASTER, level: 1, pre: false });
    }
    for (const slot of ins.fx) if (slot.sidechain === id) slot.sidechain = null;
  }
}

function clampLevel(v: number): number {
  return Number.isFinite(v) ? Math.min(MAX_INSERT_VOLUME, Math.max(0, v)) : 1;
}
