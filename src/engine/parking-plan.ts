/**
 * Which mixer inserts may stop processing their effect chain, decided from what feeds them and what their effects say.
 * Pure bookkeeping over the mixer's routing: it touches no audio node (`IdleParking` applies the plan).
 */
import { MASTER, type InsertId } from '@core/model/types';
import type { RoutingEdge } from '@core/query/routing';
import type { InsertStrip } from './insert-strip';

/** What the channels routed into one insert amount to. */
export interface ChannelFeed {
  /** Channels whose output is on the insert's channel mix right now (a parked channel is off it). */
  attached: number;
  /** Every channel routed to the insert is parked, or going to be. */
  silent: boolean;
}

/** How many sources are attached to the two mixes of an insert (see `OrderedMix.size`). */
export interface MixSizes {
  /** The insert's channel mix: channels, and anything else (a live input's monitor) that feeds it directly. */
  channelMix: number;
  /** The insert's route mix: the bus's own channel link and one padded path per route from another insert. */
  routeMix: number;
}

/** The part of the mixer a plan is made from. */
export interface ParkingView {
  readonly strips: ReadonlyMap<InsertId, InsertStrip>;
  readonly edges: readonly RoutingEdge[];
  mixSizes(id: InsertId): MixSizes;
}

/** What to change: inserts to cut off from their chain's output, and inserts to join it again. */
export interface ParkingPlan {
  park: InsertStrip[];
  unpark: InsertStrip[];
}

/**
 * Seconds of silence a native-node effect gets on top of its `tailTime` before its insert is parked: biquads ring a
 * little past what a plugin reports, and a short margin is cheap next to the saving.
 */
export const UNREPORTED_TAIL_MARGIN_SEC = 0.5;

/** The one channel mix source of an insert that is always there: the bus's own link into its route mix. */
const OWN_ROUTE_SOURCES = 1;

/**
 * Works out which inserts may be parked now. An insert may be when nothing can reach it (every channel routed to it,
 * every insert routed or sidechained into it is parked, and nothing else is attached to its mixes) and nothing inside
 * it can still sound (its effects are asleep, or have had silence in for as long as they ring). It remembers since
 * when an insert's inputs have been silent, for the effects that can only be judged by their tail.
 */
export class InsertParkingPlanner {
  private readonly silentSince = new Map<InsertId, number>();

  plan(view: ParkingView, feeds: ReadonlyMap<InsertId, ChannelFeed>, now: number): ParkingPlan {
    const sources = sourcesByTarget(view.edges);
    const wanted = new Map<InsertId, boolean>();
    const inProgress = new Set<InsertId>();

    /** Whether the insert should be parked: its sources are decided first, so a chain of buses goes quiet in order. */
    const shouldPark = (id: InsertId): boolean => {
      const known = wanted.get(id);
      if (known !== undefined) return known;
      // A routing loop is cut by the mixer before it gets here; stay awake if one slips through.
      if (inProgress.has(id)) return false;
      inProgress.add(id);
      const result = this.decide(view, id, feeds.get(id), sources.get(id) ?? [], shouldPark, now);
      inProgress.delete(id);
      wanted.set(id, result);
      return result;
    };

    const plan: ParkingPlan = { park: [], unpark: [] };
    for (const [id, strip] of view.strips) {
      const isWanted = shouldPark(id);
      if (isWanted && !strip.parked) plan.park.push(strip);
      else if (!isWanted && strip.parked) plan.unpark.push(strip);
    }
    for (const id of [...this.silentSince.keys()]) if (!view.strips.has(id)) this.silentSince.delete(id);
    return plan;
  }

  private decide(
    view: ParkingView,
    id: InsertId,
    feed: ChannelFeed | undefined,
    sources: readonly RoutingEdge[],
    shouldParkSource: (id: InsertId) => boolean,
    now: number,
  ): boolean {
    const strip = view.strips.get(id);
    // The master also takes the preview, the metronome and the decks: it always runs.
    if (!strip || id === MASTER) return this.awake(id);
    const sizes = view.mixSizes(id);
    const routesIn = sources.filter((edge) => edge.kind === 'route').length;
    const channels = feed ?? { attached: 0, silent: true };
    const hasUnknownFeeder = sizes.channelMix > channels.attached || sizes.routeMix > OWN_ROUTE_SOURCES + routesIn;
    const isSilent = channels.silent && !hasUnknownFeeder && sources.every((edge) => shouldParkSource(edge.from));
    if (!isSilent) return this.awake(id);
    const since = this.silentSince.get(id) ?? now;
    this.silentSince.set(id, since);
    const needs = strip.idleNeeds();
    return !needs.busy && now - since >= needs.tailSec;
  }

  private awake(id: InsertId): false {
    this.silentSince.delete(id);
    return false;
  }
}

/** The edges (routes and sidechains) that end at each insert. */
function sourcesByTarget(edges: readonly RoutingEdge[]): Map<InsertId, RoutingEdge[]> {
  const byTarget = new Map<InsertId, RoutingEdge[]>();
  for (const edge of edges) {
    const list = byTarget.get(edge.to);
    if (list) list.push(edge);
    else byTarget.set(edge.to, [edge]);
  }
  return byTarget;
}
