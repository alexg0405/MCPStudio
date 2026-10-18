/** Audio may not loop back on itself: this step removes the routes and sidechains that would close a loop. */
import { type RepairLog, ROUTE, countOf, noun } from './log';
import type { JsonObject } from '../json-values';

/**
 * Routes (insert → target) and sidechains (source → the slot's insert) form a graph without cycles.
 * Keeps routes before sidechains, each in mixer order, dropping the edges that would close a loop.
 */
export function breakRoutingCycles(order: readonly string[], inserts: JsonObject, log: RepairLog): void {
  const graph = new AudioGraph();

  for (const id of order) {
    const insert = inserts[id] as JsonObject;
    insert.routes = (insert.routes as JsonObject[]).filter((route) => {
      if (graph.addEdge(id, route.to as string)) return true;
      log.count('routes-loop', (n) => `Removed ${countOf(n, ROUTE)} that would loop back.`);
      return false;
    });
  }
  for (const id of order) {
    for (const slot of (inserts[id] as JsonObject).fx as JsonObject[]) {
      if (slot.sidechain === null || graph.addEdge(slot.sidechain as string, id)) continue;
      slot.sidechain = null;
      log.count('sidechain-loop', (n) => `Cleared ${countOf(n, noun('sidechain input'))} that would loop back.`);
    }
  }
}

/** The edges accepted so far, from the track whose audio flows to the track that receives it. */
class AudioGraph {
  private readonly receiversOf = new Map<string, Set<string>>();

  /** Adds `from → to` unless it points at itself or `to` already leads back to `from`. True when added. */
  addEdge(from: string, to: string): boolean {
    if (from === to || this.canReach(to, from)) return false;
    let receivers = this.receiversOf.get(from);
    if (!receivers) {
      receivers = new Set();
      this.receiversOf.set(from, receivers);
    }
    receivers.add(to);
    return true;
  }

  /** True when audio sent out of `start` ends up in `target` (a depth-first walk along the edges). */
  private canReach(start: string, target: string): boolean {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length) {
      const track = pending.pop()!;
      if (track === target) return true;
      if (visited.has(track)) continue;
      visited.add(track);
      for (const next of this.receiversOf.get(track) ?? []) pending.push(next);
    }
    return false;
  }
}
