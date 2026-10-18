/**
 * The mixer as a Web Audio graph: inserts (engine/insert-strip.ts), the routes between them, effect
 * sidechains and plugin delay compensation.
 *
 * Every insert id has persistent nodes (an InsertBus) that outlive its strip, so channels, routes
 * and sidechains never have to reconnect when an insert is rebuilt, deleted or restored:
 *
 *   channels ─► chIn ─► routeIn ─► slots ─► scTap ─► gate ─► preTap ─► pan ─► fader ─► postTap
 *   routes from other inserts ─[pad]─► routeIn          (sidechain out)  (mute/solo) (pre sends)        (post sends, meters)
 *
 * - While an insert doesn't exist (not created yet, deleted, unknown id) its chIn feeds the master,
 *   so channels routed to it play through the master.
 * - A route is tap (pre or post) ─► level gain (an AutoLane, the `route:from:to` target) ─[pad]─► the
 *   target's routeIn. A slot with a sidechain source S gets S's scTap ─[pad]─► its effect's
 *   `host.sidechain` (the slot's own input when no source is chosen).
 * - The gate sits after the effects and before the pre-fader tap, so muting (or a solo that leaves
 *   the insert out) silences pre-fader sends too. The sidechain tap is before the gate: a muted or
 *   solo-silenced kick still keys a ducker (a soloed, ducked bass still ducks).
 * - Edges are `playableEdges()`: routes plus sidechains, loops and dangling edges dropped in a fixed
 *   order. Edits disconnect what went away before anything new is connected, so audio never loops,
 *   not even for one render quantum.
 * - Delay compensation (engine/pdc.ts): the waiting is done as far upstream as the routing allows. Channels
 *   are not padded: the engine schedules the song's events for a channel `shiftSeconds(insert)` later
 *   (so live notes, which the song does not schedule, are not delayed), and each insert's own automation
 *   moves with it. What is left is a DelayNode of whole frames on a route or a sidechain where one source
 *   feeds paths that differ (none where the padding is 0, so unaffected paths stay bit-exact). Live slots
 *   only; it is recomputed whenever a slot's latency becomes known or changes (load, enable, bypass,
 *   replace, fault) and on every routing edit, and `onAlign` tells the engine.
 */
import { makeInsert } from '@core/model/defaults';
import { MASTER, type InsertId, type Mixer, type Project, type Route } from '@core/model/types';
import { effectivelyMutedInserts } from '@core/query/mixer';
import { playableEdges, type RoutingEdge } from '@core/query/routing';
import type { EngineCore } from './engine-core';
import { InsertStrip } from './insert-strip';
import { MeterScratch } from './meter-peak';
import { InsertBus, RouteLink } from './mixer-links';
import { DelayCompensation } from './pdc';

/** Used when a document has no master insert (repair adds one; the engine never runs without). */
const DEFAULT_MASTER = makeInsert(MASTER, 'Master');

/** Identifies a route between two inserts in the route map. */
const routeKey = (from: InsertId, to: InsertId) => `${from}>${to}`;

export class MixerGraph {
  readonly master: InsertStrip;
  private readonly strips = new Map<InsertId, InsertStrip>();
  private readonly buses = new Map<InsertId, InsertBus>();
  private readonly routes = new Map<string, RouteLink>();
  private readonly meterScratch = new MeterScratch();
  private edges: readonly RoutingEdge[] = [];
  private pdc: DelayCompensation | null = null;
  private batching = 0;
  private dirty = false;

  constructor(
    private readonly core: EngineCore,
    masterOut: AudioNode,
    /** Called when the mixer's total latency changes (the playhead and the UI follow it). */
    private readonly onLatency: () => void = () => {},
    /** Called after every recomputation of the compensation: channels wait `shiftSeconds(insert)` (see there). */
    private readonly onAlign: () => void = () => {},
  ) {
    const bus = this.bus(MASTER);
    bus.postTap.connect(masterOut);
    // The master insert exists before any document so channels and inserts always have a target.
    this.master = new InsertStrip(core, DEFAULT_MASTER, null, bus, () => this.latencyChanged());
    this.strips.set(MASTER, this.master);
    this.applyPdc();
  }

  /** Frames of latency the mixer adds (the longest path to the master's output). */
  get latencyFrames(): number {
    return this.pdc?.total ?? 0;
  }

  /** Seconds of latency the mixer adds. */
  get latency(): number {
    return this.latencyFrames / this.core.ctx.sampleRate;
  }

  /**
   * How long a channel routed to insert `id` is scheduled later than the song says (seconds): the delay compensation
   * is done in the channel's event times, not on the audio, so live notes (which the song doesn't schedule) hear none
   * of it. An insert that doesn't exist plays through the master.
   */
  shiftSeconds(id: InsertId): number {
    const pdc = this.pdc;
    if (!pdc) return 0;
    return pdc.arrival(this.strips.has(id) ? id : MASTER) / this.core.ctx.sampleRate;
  }

  /** Compensation currently applied (tests and diagnostics). */
  get compensation(): DelayCompensation | null {
    return this.pdc;
  }

  get ready(): Promise<void> {
    return Promise.all([...this.strips.values()].map((s) => s.ready)).then(() => undefined);
  }

  /** Where a channel routed to `id` connects (unknown inserts play through the master). */
  insertInput(id: InsertId): AudioNode {
    return this.bus(id).chIn;
  }

  /** After the fader of an insert (the master's is what leaves the mixer): where a meter listens. Null for an unknown insert. */
  outputNode(id: InsertId): AudioNode | null {
    return this.strips.has(id) ? this.bus(id).postTap : null;
  }

  strip(id: InsertId): InsertStrip | undefined {
    return this.strips.get(id);
  }

  /**
   * Keyed add/update of inserts (and their effect slots), mutes, routes and sidechains. Strips of
   * removed inserts are returned for removeStrips() once channels are reconciled; their inputs already
   * fall back to the master.
   */
  reconcile(prev: Project | null, next: Project): InsertStrip[] {
    let removed: InsertStrip[] = [];
    if (!prev || prev.mixer !== next.mixer) {
      this.batch(() => {
        removed = this.syncStrips(next);
        this.rewire(next.mixer);
        this.dirty = true;
      });
    }
    if (prev && prev.samples !== next.samples) for (const strip of this.strips.values()) strip.samplesChanged(next);
    return removed;
  }

  /** Creates and updates the strips of the document's inserts, sets their mutes; returns the strips of removed inserts. */
  private syncStrips(next: Project): InsertStrip[] {
    const inserts = next.mixer.inserts;
    for (const id of Object.keys(inserts) as InsertId[]) {
      const insert = inserts[id];
      if (!insert) continue;
      const strip = this.strips.get(id);
      if (strip) strip.update(insert, next);
      else this.strips.set(id, new InsertStrip(this.core, insert, next, this.bus(id), () => this.latencyChanged()));
    }
    if (!inserts[MASTER]) this.master.update(DEFAULT_MASTER, next);
    const removed: InsertStrip[] = [];
    for (const [id, strip] of this.strips) {
      if (id === MASTER || inserts[id]) continue;
      this.strips.delete(id);
      removed.push(strip);
    }
    const muted = effectivelyMutedInserts(inserts);
    for (const [id, strip] of this.strips) strip.setMuted(muted.has(id));
    return removed;
  }

  /** The set of automated plugin instances changed: effects that ran as lite processors may need the full one. */
  automationChanged(project: Project): void {
    for (const strip of this.strips.values()) strip.automationChanged(project);
  }

  removeStrips(strips: readonly InsertStrip[]): void {
    for (const strip of strips) strip.dispose();
  }

  /** Rebuilds effects whose plugin definition changed (hot reload, install/uninstall). */
  pluginsChanged(ids: ReadonlySet<string>, project: Project): void {
    this.batch(() => {
      for (const strip of this.strips.values()) strip.pluginsChanged(ids, project);
    });
  }

  readMeters(order: readonly InsertId[], out: Float32Array): void {
    for (let i = 0; i < order.length; i++) {
      const strip = this.strips.get(order[i] as InsertId);
      if (strip) strip.readPeaks(this.meterScratch, out, i * 2);
      else if (i * 2 + 1 < out.length) {
        out[i * 2] = 0;
        out[i * 2 + 1] = 0;
      }
    }
  }

  /**
   * Seconds of effect tail along the deepest route path to the master: effects in series add their
   * tails (a reverb on a bus after a delay on a track rings for both).
   */
  tailSeconds(): number {
    const tailAfter = new Map<InsertId, number>();
    const targetsOf = new Map<InsertId, InsertId[]>();
    for (const edge of this.edges) {
      if (edge.kind !== 'route') continue;
      const targets = targetsOf.get(edge.from);
      if (targets) targets.push(edge.to);
      else targetsOf.set(edge.from, [edge.to]);
    }
    /** The tail of an insert's own effects plus the longest tail of what it feeds. */
    const tailFrom = (id: InsertId): number => {
      const known = tailAfter.get(id);
      if (known !== undefined) return known;
      let longestBeyond = 0;
      for (const to of targetsOf.get(id) ?? []) longestBeyond = Math.max(longestBeyond, tailFrom(to));
      const total = (this.strips.get(id)?.tailTime ?? 0) + longestBeyond;
      tailAfter.set(id, total);
      return total;
    };
    let longest = 0;
    for (const id of this.strips.keys()) longest = Math.max(longest, tailFrom(id));
    return longest;
  }

  dispose(): void {
    for (const link of this.routes.values()) link.dispose();
    this.routes.clear();
    for (const strip of this.strips.values()) strip.dispose();
    this.strips.clear();
    for (const bus of this.buses.values()) bus.dispose();
    this.buses.clear();
  }

  private bus(id: InsertId): InsertBus {
    let bus = this.buses.get(id);
    if (!bus) {
      bus = new InsertBus(this.core.ctx, this.core.offline);
      this.buses.set(id, bus);
      // Until its insert exists (it may never), the bus plays through the master.
      if (id !== MASTER) bus.chLink.set(this.bus(MASTER).chIn, 0);
    }
    return bus;
  }

  private batch(fn: () => void): void {
    this.batching++;
    try {
      fn();
    } finally {
      this.batching--;
    }
    if (this.batching === 0 && this.dirty) {
      this.dirty = false;
      this.applyPdc();
    }
  }

  private latencyChanged(): void {
    if (this.batching > 0) this.dirty = true;
    else this.applyPdc();
  }

  /** Brings routes and sidechain sources in line with the document: removals first, then additions. */
  private rewire(mixer: Mixer): void {
    const edges = playableEdges(mixer);
    const wantedRoutes = new Map<string, { from: InsertId; to: InsertId; route: Route }>();
    const sidechainSources = new Map<string, InsertId>();
    for (const edge of edges) {
      if (edge.kind === 'route') {
        const route = mixer.inserts[edge.from]?.routes.find((r) => r.to === edge.to);
        if (route) wantedRoutes.set(routeKey(edge.from, edge.to), { from: edge.from, to: edge.to, route });
      } else if (edge.slotId) {
        sidechainSources.set(`${edge.to}/${edge.slotId}`, edge.from);
      }
    }
    // 1. Disconnect: routes that went away, sidechain inputs whose source changed or went away
    //    (they key from their own input until applyPdc connects the new source).
    for (const [key, link] of this.routes) {
      if (wantedRoutes.has(key)) continue;
      link.dispose();
      this.routes.delete(key);
    }
    for (const [id, strip] of this.strips) {
      for (const slot of strip.slotStrips) {
        const from = sidechainSources.get(`${id}/${slot.id}`);
        if (slot.keySource !== (from ? this.bus(from).scTap : null)) slot.setKey(null);
      }
    }
    // 2. New routes, connected only up to their level gain: applyPdc connects them to their
    //    targets (padded), and the new sidechain sources, once everything stale is gone.
    for (const [key, wanted] of wantedRoutes) {
      const link = this.routes.get(key);
      if (link) link.update(wanted.route);
      else this.routes.set(key, new RouteLink(this.core.ctx, this.core, wanted.from, wanted.to, wanted.route, this.bus(wanted.from)));
    }
    this.edges = edges;
  }

  /** Recomputes delay compensation and applies every padding (and each bus's channel input). */
  private applyPdc(): void {
    const ids = [...this.strips.keys()];
    const pdc = new DelayCompensation(ids, this.edges, (id) =>
      (this.strips.get(id)?.slotStrips ?? []).map((s) => ({
        slotId: s.id,
        frames: s.latencyFrames,
        keyed: s.listens,
      })),
    );
    const changed = this.pdc !== null && this.pdc.total !== pdc.total;
    this.pdc = pdc;
    const masterIn = this.bus(MASTER).chIn;
    // Channels are not padded: the engine schedules them later by the insert's arrival (`shiftSeconds`).
    for (const [id, bus] of this.buses) {
      if (this.strips.has(id)) bus.chLink.set(bus.routeIn, 0);
      else if (id !== MASTER) bus.chLink.set(masterIn, 0);
    }
    const sampleRate = this.core.ctx.sampleRate;
    for (const link of this.routes.values()) {
      link.pad.set(this.bus(link.to).routeIn, pdc.routePad(link.from, link.to));
      link.setShift(pdc.out(link.from) / sampleRate);
    }
    for (const [id, strip] of this.strips) strip.setAlignment(pdc.arrival(id));
    for (const e of this.edges) {
      if (e.kind !== 'sidechain' || !e.slotId) continue;
      const slot = this.strips.get(e.to)?.slotStrips.find((s) => s.id === e.slotId);
      slot?.setKey(this.bus(e.from).scTap, pdc.keyPad(e.from, e.to, e.slotId));
    }
    if (changed) this.onLatency();
    this.onAlign();
  }
}
