/**
 * The mixer as a Web Audio graph: inserts (engine/insert-strip.ts), the routes between them, effect
 * sidechains and plugin delay compensation.
 *
 * Every insert id has persistent nodes (an InsertBus) that outlive its strip, so channels, routes
 * and sidechains never have to reconnect when an insert is rebuilt, deleted or restored:
 *
 *   channels ─► chIn ─[pad: arrival]─► routeIn ─► slots ─► scTap ─► gate ─► preTap ─► pan ─► fader ─► postTap
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
 * - Delay compensation (engine/pdc.ts): an insert's audio arrives as late as its latest input and
 *   every shorter edge is padded with a DelayNode of whole frames (none where the padding is 0, so
 *   unaffected paths stay bit-exact). Live slots only; it is recomputed whenever a slot's latency
 *   becomes known or changes (load, enable, bypass, replace, fault) and on every routing edit.
 */
import { makeInsert } from '@core/model/defaults';
import { MASTER, type InsertId, type Mixer, type Project, type Route } from '@core/model/types';
import { ROUTE_LEVEL_SPEC } from '@core/model/target-specs';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { targetKey } from '@core/model/targets';
import { effectivelyMutedInserts } from '@core/query/mixer';
import { playableEdges, type RoutingEdge } from '@core/query/routing';
import type { EngineCore } from './engine-core';
import { disconnectFrom, frameDelay, InsertStrip, METER_FRAMES, type InsertTaps } from './insert-strip';
import { AutoLane } from './param-lane';
import { DelayCompensation } from './pdc';

/** Used when a document has no master insert (repair adds one; the engine never runs without). */
const DEFAULT_MASTER = makeInsert(MASTER, 'Master');
/** Time constant of send-level moves (matches faders). */
const ROUTE_TAU = 0.004;
/** Crossfade when a padded link changes its delay or target while audio runs. */
const LINK_FADE = 0.01;
/** The faded-out path is dropped after this long. */
const LINK_DROP_MS = 60;

const clampLevel = (v: number) => (Number.isFinite(v) ? Math.min(MAX_INSERT_VOLUME, Math.max(0, v)) : 1);

interface Path {
  to: AudioNode;
  frames: number;
  delay: DelayNode | null;
  gain: GainNode;
}

/**
 * from ─► [DelayNode of `frames` frames] ─► gain ─► to. Changing the delay or the target while the
 * context runs crossfades the old path out over 10 ms (a hard switch would click); before the
 * context starts (offline renders apply everything at time 0) it switches exactly.
 */
export class PadLink {
  private path: Path | null = null;
  /** Paths fading out, dropped by their timer (or on dispose). */
  private readonly fading = new Map<Path, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly from: AudioNode,
  ) {}

  get frames(): number {
    return this.path?.frames ?? 0;
  }

  get target(): AudioNode | null {
    return this.path?.to ?? null;
  }

  set(to: AudioNode | null, frames: number): void {
    const old = this.path;
    if (old?.to === to && (to === null || old?.frames === frames)) return;
    // Crossfade only while audio runs and there is something to fade from.
    const fade = !!old && this.ctx.currentTime > 0;
    const next = to ? this.build(to, frames, fade ? 0 : 1) : null;
    this.path = next;
    if (old && fade) {
      const t = this.ctx.currentTime;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(1, t);
      old.gain.gain.linearRampToValueAtTime(0, t + LINK_FADE);
      next?.gain.gain.setValueAtTime(0, t);
      next?.gain.gain.linearRampToValueAtTime(1, t + LINK_FADE);
      this.fading.set(
        old,
        setTimeout(() => {
          this.fading.delete(old);
          this.drop(old);
        }, LINK_DROP_MS),
      );
    } else if (old) this.drop(old);
  }

  dispose(): void {
    for (const [p, timer] of this.fading) {
      clearTimeout(timer);
      this.drop(p);
    }
    this.fading.clear();
    if (this.path) this.drop(this.path);
    this.path = null;
  }

  private build(to: AudioNode, frames: number, gain: number): Path {
    const g = new GainNode(this.ctx, { gain });
    let delay: DelayNode | null = null;
    if (frames > 0) {
      delay = frameDelay(this.ctx, frames);
      this.from.connect(delay).connect(g);
    } else this.from.connect(g);
    g.connect(to);
    return { to, frames, delay, gain: g };
  }

  private drop(p: Path): void {
    if (p.delay) {
      disconnectFrom(this.from, p.delay);
      p.delay.disconnect();
    } else disconnectFrom(this.from, p.gain);
    p.gain.disconnect();
  }
}

/** The persistent nodes of one insert id (see the file comment). */
class InsertBus implements InsertTaps {
  readonly chIn: GainNode;
  readonly routeIn: GainNode;
  readonly scTap: GainNode;
  readonly preTap: GainNode;
  readonly postTap: GainNode;
  /** chIn → routeIn (padded by the arrival latency), or chIn → the master while the insert is gone. */
  readonly chLink: PadLink;

  constructor(ctx: BaseAudioContext) {
    this.chIn = new GainNode(ctx);
    this.routeIn = new GainNode(ctx);
    this.scTap = new GainNode(ctx);
    this.preTap = new GainNode(ctx);
    this.postTap = new GainNode(ctx);
    this.chLink = new PadLink(ctx, this.chIn);
  }

  dispose(): void {
    this.chLink.dispose();
    for (const n of [this.chIn, this.routeIn, this.scTap, this.preTap, this.postTap]) n.disconnect();
  }
}

/** A route between two inserts: tap → level → [pad] → the target's routeIn. */
class RouteLink {
  readonly gain: GainNode;
  readonly pad: PadLink;
  private readonly lane: AutoLane;
  private readonly unregister: () => void;
  private tap: AudioNode;
  private route: Route;

  constructor(
    private readonly ctx: BaseAudioContext,
    core: EngineCore,
    readonly from: InsertId,
    readonly to: InsertId,
    route: Route,
    private readonly source: InsertBus,
  ) {
    this.route = route;
    const level = clampLevel(route.level);
    this.gain = new GainNode(ctx, { gain: level });
    this.lane = new AutoLane(ctx, targetKey({ kind: 'route', insertId: from, to }), ROUTE_LEVEL_SPEC, level, ROUTE_TAU);
    this.lane.bind(this.gain.gain);
    this.unregister = core.params.register(this.lane);
    this.tap = route.pre ? source.preTap : source.postTap;
    this.tap.connect(this.gain);
    this.pad = new PadLink(ctx, this.gain);
  }

  update(route: Route): void {
    const prev = this.route;
    if (prev === route) return;
    this.route = route;
    if (prev.level !== route.level) this.lane.setBase(clampLevel(route.level), this.ctx.currentTime);
    if (prev.pre !== route.pre) {
      disconnectFrom(this.tap, this.gain);
      this.tap = route.pre ? this.source.preTap : this.source.postTap;
      this.tap.connect(this.gain);
    }
  }

  dispose(): void {
    this.pad.dispose();
    disconnectFrom(this.tap, this.gain);
    this.gain.disconnect();
    this.unregister();
    this.lane.dispose();
  }
}

const routeKey = (from: InsertId, to: InsertId) => `${from}>${to}`;

export class MixerGraph {
  readonly master: InsertStrip;
  private readonly strips = new Map<InsertId, InsertStrip>();
  private readonly buses = new Map<InsertId, InsertBus>();
  private readonly routes = new Map<string, RouteLink>();
  private readonly meterScratch = new Float32Array(METER_FRAMES);
  private edges: readonly RoutingEdge[] = [];
  private pdc: DelayCompensation | null = null;
  private batching = 0;
  private dirty = false;

  constructor(
    private readonly core: EngineCore,
    masterOut: AudioNode,
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

  strip(id: InsertId): InsertStrip | undefined {
    return this.strips.get(id);
  }

  /**
   * Keyed add/update of inserts (and their effect slots), mutes, routes and sidechains. Strips of
   * removed inserts are returned for removeStrips() once channels are reconciled; their inputs already
   * fall back to the master.
   */
  reconcile(prev: Project | null, next: Project): InsertStrip[] {
    const removed: InsertStrip[] = [];
    if (!prev || prev.mixer !== next.mixer) {
      this.batch(() => {
        const inserts = next.mixer.inserts;
        for (const id of Object.keys(inserts) as InsertId[]) {
          const insert = inserts[id];
          if (!insert) continue;
          const strip = this.strips.get(id);
          if (strip) strip.update(insert, next);
          else this.strips.set(id, new InsertStrip(this.core, insert, next, this.bus(id), () => this.latencyChanged()));
        }
        if (!inserts[MASTER]) this.master.update(DEFAULT_MASTER, next);
        for (const [id, strip] of this.strips) {
          if (id === MASTER || inserts[id]) continue;
          this.strips.delete(id);
          removed.push(strip);
        }
        const muted = effectivelyMutedInserts(inserts);
        for (const [id, strip] of this.strips) strip.setMuted(muted.has(id));
        this.rewire(next.mixer);
        this.dirty = true;
      });
    }
    if (prev && prev.samples !== next.samples) for (const strip of this.strips.values()) strip.samplesChanged(next);
    return removed;
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
    const after = new Map<InsertId, number>();
    const next = new Map<InsertId, InsertId[]>();
    for (const e of this.edges) {
      if (e.kind !== 'route') continue;
      const l = next.get(e.from);
      if (l) l.push(e.to);
      else next.set(e.from, [e.to]);
    }
    const down = (id: InsertId): number => {
      const known = after.get(id);
      if (known !== undefined) return known;
      let rest = 0;
      for (const to of next.get(id) ?? []) rest = Math.max(rest, down(to));
      const total = (this.strips.get(id)?.tailTime ?? 0) + rest;
      after.set(id, total);
      return total;
    };
    let max = 0;
    for (const id of this.strips.keys()) max = Math.max(max, down(id));
    return max;
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
      bus = new InsertBus(this.core.ctx);
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
    const wanted = new Map<string, { from: InsertId; to: InsertId; route: Route }>();
    const keys = new Map<string, InsertId>();
    for (const e of edges) {
      if (e.kind === 'route') {
        const route = mixer.inserts[e.from]?.routes.find((r) => r.to === e.to);
        if (route) wanted.set(routeKey(e.from, e.to), { from: e.from, to: e.to, route });
      } else if (e.slotId) keys.set(`${e.to}/${e.slotId}`, e.from);
    }
    // 1. Disconnect: routes that went away, sidechain inputs whose source changed or went away
    //    (they key from their own input until applyPdc connects the new source).
    for (const [key, link] of this.routes) {
      if (wanted.has(key)) continue;
      link.dispose();
      this.routes.delete(key);
    }
    for (const [id, strip] of this.strips)
      for (const slot of strip.slotStrips) {
        const from = keys.get(`${id}/${slot.id}`);
        if (slot.keySource !== (from ? this.bus(from).scTap : null)) slot.setKey(null);
      }
    // 2. New routes, connected only up to their level gain: applyPdc connects them to their
    //    targets (padded), and the new sidechain sources, once everything stale is gone.
    for (const [key, w] of wanted) {
      const link = this.routes.get(key);
      if (link) link.update(w.route);
      else this.routes.set(key, new RouteLink(this.core.ctx, this.core, w.from, w.to, w.route, this.bus(w.from)));
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
    this.pdc = pdc;
    const masterIn = this.bus(MASTER).chIn;
    for (const [id, bus] of this.buses) {
      if (this.strips.has(id)) bus.chLink.set(bus.routeIn, pdc.arrival(id));
      else if (id !== MASTER) bus.chLink.set(masterIn, 0);
    }
    for (const link of this.routes.values()) link.pad.set(this.bus(link.to).routeIn, pdc.routePad(link.from, link.to));
    for (const e of this.edges) {
      if (e.kind !== 'sidechain' || !e.slotId) continue;
      const slot = this.strips.get(e.to)?.slotStrips.find((s) => s.id === e.slotId);
      slot?.setKey(this.bus(e.from).scTap, pdc.keyPad(e.from, e.to, e.slotId));
    }
  }
}
