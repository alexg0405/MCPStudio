/**
 * The mixer's routing graph: routes (insert → target) and sidechains (source insert → the insert
 * whose effect listens). Audio may not loop, so every edit checks `wouldCycle` first.
 */
import { MASTER, type Insert, type InsertId, type Mixer, type SlotId } from '../model/types';

/**
 * One connection in the mixer's routing graph: from one insert to another, either a route or a sidechain (with the
 * listening slot).
 */
export interface RoutingEdge {
  from: InsertId;
  to: InsertId;
  kind: 'route' | 'sidechain';
  /** The listening slot (sidechain edges). */
  slotId?: SlotId;
}

type Inserts = Readonly<Record<InsertId, Insert>>;

const edgeCache = new WeakMap<object, readonly RoutingEdge[]>();

/** Every routing edge, routes first (memoized by the inserts record's identity). */
export function routingEdges(inserts: Inserts): readonly RoutingEdge[] {
  const cached = edgeCache.get(inserts);
  if (cached) return cached;
  const out: RoutingEdge[] = [];
  for (const ins of Object.values(inserts))
    for (const r of ins.routes) out.push({ from: ins.id, to: r.to, kind: 'route' });
  for (const ins of Object.values(inserts))
    for (const slot of ins.fx)
      if (slot.sidechain) out.push({ from: slot.sidechain, to: ins.id, kind: 'sidechain', slotId: slot.id });
  edgeCache.set(inserts, out);
  return out;
}

function successors(inserts: Inserts, id: InsertId): InsertId[] {
  const out: InsertId[] = [];
  for (const r of inserts[id]?.routes ?? []) out.push(r.to);
  for (const ins of Object.values(inserts)) if (ins.fx.some((s) => s.sidechain === id)) out.push(ins.id);
  return out;
}

/** Whether audio from `from` can reach `to` (through routes and sidechains). Works on drafts. */
export function reaches(inserts: Inserts, from: InsertId, to: InsertId): boolean {
  const seen = new Set<InsertId>();
  const stack = [from];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...successors(inserts, at));
  }
  return false;
}

/** Whether adding an edge from → to would make audio loop (or is a self-edge). Works on drafts. */
export function wouldCycle(inserts: Inserts, from: InsertId, to: InsertId): boolean {
  return from === to || reaches(inserts, to, from);
}

/** Whether `from` may route to `to`: both exist, `from` is not the master, and no loop results. */
export function canRoute(mixer: Mixer, from: InsertId, to: InsertId): boolean {
  const { inserts } = mixer;
  if (from === MASTER || !inserts[from] || !inserts[to]) return false;
  return inserts[from].routes.some((r) => r.to === to) || !wouldCycle(inserts, from, to);
}

const playableCache = new WeakMap<object, readonly RoutingEdge[]>();

/** Insert ids in mixer order, then any insert the order is missing (damaged documents). */
function idsInOrder(mixer: Mixer): InsertId[] {
  const out: InsertId[] = [];
  const seen = new Set<InsertId>();
  for (const id of mixer.order)
    if (mixer.inserts[id] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  for (const id of Object.keys(mixer.inserts) as InsertId[])
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  return out;
}

/**
 * The edges audio actually follows, forming a graph without loops: routes first (mixer order, each
 * insert's routes in order), then sidechains (mixer order, slot order). Edges from or to a missing
 * insert, routes from the master, repeated route targets and edges that would close a loop are
 * skipped: the choices repair makes, so even a damaged document can't make the engine loop.
 * Memoized by the mixer's identity.
 */
export function playableEdges(mixer: Mixer): readonly RoutingEdge[] {
  const cached = playableCache.get(mixer);
  if (cached) return cached;
  const { inserts } = mixer;
  const next = new Map<InsertId, InsertId[]>();
  const reachable = (from: InsertId, to: InsertId): boolean => {
    const seen = new Set<InsertId>();
    const stack = [from];
    while (stack.length) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const n of next.get(at) ?? []) stack.push(n);
    }
    return false;
  };
  const accept = (from: InsertId, to: InsertId): boolean => {
    if (from === to || !inserts[from] || !inserts[to] || reachable(to, from)) return false;
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
    return true;
  };
  const out: RoutingEdge[] = [];
  const ids = idsInOrder(mixer);
  for (const id of ids) {
    if (id === MASTER) continue;
    const targets = new Set<InsertId>();
    for (const r of inserts[id]!.routes) {
      if (targets.has(r.to)) continue;
      targets.add(r.to);
      if (accept(id, r.to)) out.push({ from: id, to: r.to, kind: 'route' });
    }
  }
  for (const id of ids)
    for (const slot of inserts[id]!.fx)
      if (slot.sidechain && accept(slot.sidechain, id))
        out.push({ from: slot.sidechain, to: id, kind: 'sidechain', slotId: slot.id });
  playableCache.set(mixer, out);
  return out;
}

/** Inserts that route straight into `id`. */
export function routeSources(inserts: Inserts, id: InsertId): InsertId[] {
  return Object.values(inserts)
    .filter((ins) => ins.routes.some((r) => r.to === id))
    .map((ins) => ins.id);
}

/** Inserts ordered so every edge goes forward (sources before targets); the master comes last. */
export function topologicalOrder(mixer: Mixer): InsertId[] {
  const { inserts } = mixer;
  const out: InsertId[] = [];
  const state = new Map<InsertId, 1 | 2>();
  const visit = (id: InsertId) => {
    if (state.get(id)) return; // done or (impossible after repair) on the stack
    state.set(id, 1);
    for (const next of successors(inserts, id)) visit(next);
    state.set(id, 2);
    out.push(id);
  };
  for (const id of mixer.order) visit(id);
  return out.reverse();
}
