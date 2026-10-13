/**
 * Plugin delay compensation over the mixer's routing graph, in whole frames. Pure (no Web Audio),
 * so it is unit-tested in Node.
 *
 * For an insert X with live slots of latency l₁…lₙ (bypassed, loading, missing or failed slots
 * count 0): `before(X, k)` is the latency of the slots ahead of slot k and `fx(X)` all of them.
 * - arrival(X) = max(0, out(S) for every route S → X, out(S) − before(X, k) for every sidechain
 *   S → X keying a live slot k): the latest anything arrives, so nothing has to arrive "early";
 * - out(X) = arrival(X) + fx(X): the latency at X's taps (pre, post and sidechain);
 * - each edge is padded up to that: channels into X by arrival(X), a route S → X by
 *   arrival(X) − out(S), a sidechain S → X (slot k) by arrival(X) + before(X, k) − out(S);
 * - the mixer's latency is out(master).
 */
import { MASTER, type InsertId, type SlotId } from '@core/model/types';
import type { RoutingEdge } from '@core/query/routing';

export interface SlotLatency {
  slotId: SlotId;
  /** Frames the slot delays its output by (0 unless the effect is live). */
  frames: number;
  /** The slot's live effect listens to a sidechain (so its key's arrival matters). */
  keyed: boolean;
}

export class DelayCompensation {
  private readonly arrivals = new Map<InsertId, number>();
  private readonly outs = new Map<InsertId, number>();
  private readonly befores = new Map<string, number>();
  /** Frames of latency at the master's output. */
  readonly total: number;

  /**
   * `edges` must form a graph without loops (`playableEdges`); edges touching an insert missing
   * from `ids` are ignored.
   */
  constructor(
    ids: readonly InsertId[],
    edges: readonly RoutingEdge[],
    slots: (id: InsertId) => readonly SlotLatency[],
  ) {
    const known = new Set(ids);
    const incoming = new Map<InsertId, RoutingEdge[]>();
    const outgoing = new Map<InsertId, RoutingEdge[]>();
    const pending = new Map<InsertId, number>();
    for (const id of ids) pending.set(id, 0);
    for (const e of edges) {
      if (!known.has(e.from) || !known.has(e.to)) continue;
      push(incoming, e.to, e);
      push(outgoing, e.from, e);
      pending.set(e.to, (pending.get(e.to) ?? 0) + 1);
    }
    const fx = new Map<InsertId, number>();
    const keyed = new Set<string>();
    for (const id of ids) {
      let sum = 0;
      for (const s of slots(id)) {
        this.befores.set(slotKey(id, s.slotId), sum);
        if (s.keyed) keyed.add(slotKey(id, s.slotId));
        sum += Math.max(0, Math.round(s.frames));
      }
      fx.set(id, sum);
    }
    // Kahn's algorithm: an insert is settled once everything feeding it is.
    const ready = ids.filter((id) => pending.get(id) === 0);
    while (ready.length) {
      const id = ready.pop()!;
      let arrival = 0;
      for (const e of incoming.get(id) ?? []) {
        const src = this.outs.get(e.from) ?? 0;
        if (e.kind === 'route') arrival = Math.max(arrival, src);
        else if (e.slotId && keyed.has(slotKey(id, e.slotId)))
          arrival = Math.max(arrival, src - (this.befores.get(slotKey(id, e.slotId)) ?? 0));
      }
      this.arrivals.set(id, arrival);
      this.outs.set(id, arrival + (fx.get(id) ?? 0));
      for (const e of outgoing.get(id) ?? []) {
        const left = (pending.get(e.to) ?? 0) - 1;
        pending.set(e.to, left);
        if (left === 0) ready.push(e.to);
      }
    }
    this.total = this.outs.get(MASTER) ?? 0;
  }

  /** Frames by which audio reaching the insert is late; channels into it are padded by this much. */
  arrival(id: InsertId): number {
    return this.arrivals.get(id) ?? 0;
  }

  /** Frames of latency at the insert's taps. */
  out(id: InsertId): number {
    return this.outs.get(id) ?? 0;
  }

  /** Padding of the route from → to. */
  routePad(from: InsertId, to: InsertId): number {
    return Math.max(0, this.arrival(to) - this.out(from));
  }

  /** Padding of the sidechain from `source` into slot `slotId` of insert `to`. */
  keyPad(source: InsertId, to: InsertId, slotId: SlotId): number {
    return Math.max(0, this.arrival(to) + (this.befores.get(slotKey(to, slotId)) ?? 0) - this.out(source));
  }
}

function slotKey(id: InsertId, slot: SlotId): string {
  return `${id}/${slot}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
