/**
 * Plugin delay compensation over the mixer's routing graph, in whole frames. Pure (no Web Audio),
 * so it is unit-tested in Node.
 *
 * For an insert X with live slots of latency l₁…lₙ (bypassed, loading, missing or failed slots
 * count 0): `before(X, k)` is the latency of the slots ahead of slot k and `fx(X)` all of them.
 *
 * Everything that is heard has to come out at the same distance from the moment it was scheduled, which is the
 * longest path to the master (`total`). Where the extra waiting happens is the choice this makes:
 *
 * - `arrival(X)` is how late (after its scheduled time) the audio entering X is. The waiting is done as far
 *   upstream as the routing allows ("as late as possible" scheduling, the opposite of padding at each join):
 *   channels are scheduled `arrival(X)` frames later by the engine (a note's time moves, no delay line sits on
 *   the audio), so a live note, which is not scheduled by the song, goes through with no delay at all;
 * - `out(X) = arrival(X) + fx(X)`: the latency at X's taps (pre, post and sidechain);
 * - a route S → X still gets a delay line for what is left, `arrival(X) − out(S)` (nothing on the route that
 *   limits X, and nothing at all along a chain of tracks that have one route each); a sidechain S → X (slot k)
 *   gets `arrival(X) + before(X, k) − out(S)`;
 * - the mixer's latency is `out(master)`.
 *
 * Earlier versions padded each join to the *earliest* alignment (arrival(X) = the latest input), which put a delay
 * line on every shorter edge, live notes included.
 */
import { MASTER, type InsertId, type SlotId } from '@core/model/types';
import type { RoutingEdge } from '@core/query/routing';

/** What the compensation needs to know about one effect slot of an insert. */
export interface SlotLatency {
  slotId: SlotId;
  /** Frames the slot delays its output by (0 unless the effect is live). */
  frames: number;
  /** The slot's live effect listens to a sidechain (so its key's arrival matters). */
  keyed: boolean;
}

/** The routing graph of the known inserts, with what Kahn's algorithm needs to walk it. */
interface Graph {
  incoming: Map<InsertId, RoutingEdge[]>;
  outgoing: Map<InsertId, RoutingEdge[]>;
  /** Edges into each insert that are not settled yet. */
  pending: Map<InsertId, number>;
}

/** The effect latency of each insert, and which slots have a sidechain that is listened to. */
interface SlotTotals {
  /** Frames of all the live slots of an insert. */
  fx: Map<InsertId, number>;
  /** Keys (`insert/slot`) of the slots that listen to a sidechain. */
  keyed: Set<string>;
}

/** The first pass: the earliest each insert's audio can be aligned. */
interface ForwardPass {
  early: Map<InsertId, number>;
  /** The inserts in the order they were settled (sources before what they feed). */
  order: InsertId[];
  total: number;
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
    const graph = buildGraph(ids, edges);
    const slotTotals = this.measureSlots(ids, slots);
    const forward = this.settleForward(ids, graph, slotTotals);
    this.total = forward.total;
    this.settleBackward(forward, graph, slotTotals);
  }

  /** Records the latency ahead of every slot (`befores`) and sums each insert's slots. */
  private measureSlots(ids: readonly InsertId[], slots: (id: InsertId) => readonly SlotLatency[]): SlotTotals {
    const fx = new Map<InsertId, number>();
    const keyed = new Set<string>();
    for (const id of ids) {
      let sum = 0;
      for (const slot of slots(id)) {
        this.befores.set(slotKey(id, slot.slotId), sum);
        if (slot.keyed) keyed.add(slotKey(id, slot.slotId));
        sum += Math.max(0, Math.round(slot.frames));
      }
      fx.set(id, sum);
    }
    return { fx, keyed };
  }

  /**
   * Forward (Kahn's algorithm: an insert is settled once everything feeding it is): the earliest each insert's
   * audio can be aligned, which gives the mixer's latency.
   */
  private settleForward(ids: readonly InsertId[], graph: Graph, { fx, keyed }: SlotTotals): ForwardPass {
    const { incoming, outgoing, pending } = graph;
    const early = new Map<InsertId, number>();
    const earlyOut = new Map<InsertId, number>();
    const order: InsertId[] = [];
    const ready = ids.filter((id) => pending.get(id) === 0);
    while (ready.length) {
      const id = ready.pop()!;
      order.push(id);
      let arrival = 0;
      for (const edge of incoming.get(id) ?? []) {
        const sourceOut = earlyOut.get(edge.from) ?? 0;
        if (edge.kind === 'route') {
          arrival = Math.max(arrival, sourceOut);
        } else if (edge.slotId && keyed.has(slotKey(id, edge.slotId))) {
          arrival = Math.max(arrival, sourceOut - (this.befores.get(slotKey(id, edge.slotId)) ?? 0));
        }
      }
      early.set(id, arrival);
      earlyOut.set(id, arrival + (fx.get(id) ?? 0));
      for (const edge of outgoing.get(id) ?? []) {
        const left = (pending.get(edge.to) ?? 0) - 1;
        pending.set(edge.to, left);
        if (left === 0) ready.push(edge.to);
      }
    }
    return { early, order, total: earlyOut.get(MASTER) ?? 0 };
  }

  /**
   * Backward: each insert as late as what it feeds allows. The master stays where the forward pass put it (so
   * the total is the same); an insert that feeds nothing that is heard (no route out, no key taken from it) is
   * silent and constrains nobody.
   */
  private settleBackward({ early, order }: ForwardPass, { outgoing }: Graph, { fx, keyed }: SlotTotals): void {
    const dead = new Set<InsertId>();
    for (const id of order) if (id !== MASTER && (outgoing.get(id)?.length ?? 0) === 0) dead.add(id);
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i] as InsertId;
      const ownFx = fx.get(id) ?? 0;
      let arrival = id === MASTER ? (early.get(MASTER) ?? 0) : Number.POSITIVE_INFINITY;
      for (const edge of outgoing.get(id) ?? []) {
        if (dead.has(edge.to)) continue;
        const targetArrival = this.arrivals.get(edge.to);
        if (targetArrival === undefined) continue;
        if (edge.kind === 'route') {
          arrival = Math.min(arrival, targetArrival - ownFx);
        } else if (edge.slotId && keyed.has(slotKey(edge.to, edge.slotId))) {
          const beforeSlot = this.befores.get(slotKey(edge.to, edge.slotId)) ?? 0;
          arrival = Math.min(arrival, targetArrival + beforeSlot - ownFx);
        }
      }
      if (!Number.isFinite(arrival)) arrival = early.get(id) ?? 0;
      this.arrivals.set(id, arrival);
      this.outs.set(id, arrival + ownFx);
    }
  }

  /**
   * Frames by which audio reaching the insert is late. The engine schedules every channel routed into it this much
   * later instead of delaying the audio, and moves the insert's own automation by the same amount.
   */
  arrival(id: InsertId): number {
    return this.arrivals.get(id) ?? 0;
  }

  /** Frames of latency at the insert's taps. */
  out(id: InsertId): number {
    return this.outs.get(id) ?? 0;
  }

  /** Frames of the slots ahead of slot `slotId` in the insert (0 for an unknown slot). */
  before(id: InsertId, slotId: SlotId): number {
    return this.befores.get(slotKey(id, slotId)) ?? 0;
  }

  /** The delay line on the route from → to (what is left after scheduling things later upstream). */
  routePad(from: InsertId, to: InsertId): number {
    return Math.max(0, this.arrival(to) - this.out(from));
  }

  /** The delay line on the sidechain from `source` into slot `slotId` of insert `to`. */
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

/** The edges between the known inserts, indexed by both ends. Edges touching an unknown insert are ignored. */
function buildGraph(ids: readonly InsertId[], edges: readonly RoutingEdge[]): Graph {
  const known = new Set(ids);
  const incoming = new Map<InsertId, RoutingEdge[]>();
  const outgoing = new Map<InsertId, RoutingEdge[]>();
  const pending = new Map<InsertId, number>();
  for (const id of ids) pending.set(id, 0);
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    push(incoming, edge.to, edge);
    push(outgoing, edge.from, edge);
    pending.set(edge.to, (pending.get(edge.to) ?? 0) + 1);
  }
  return { incoming, outgoing, pending };
}
