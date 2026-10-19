import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { ROUTE_LEVEL_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import type { InsertId, Route } from '@core/model/types';
import { OrderedMix } from '@agstudio/sdk';
import { disconnectFrom } from './audio-graph';
import type { EngineCore } from './engine-core';
import type { InsertTaps } from './insert-strip';
import { PadLink } from './pad-link';
import { AutoLane } from './param-lane';

/** Time constant of send-level moves (seconds; matches faders). */
const ROUTE_LEVEL_TAU_SEC = 0.004;

/** A send level limited to what a fader can reach; a level that is not a number means unity. */
function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(MAX_INSERT_VOLUME, Math.max(0, level)) : 1;
}

/** The persistent nodes of one insert id (see the comment of mixer-graph.ts). */
export class InsertBus implements InsertTaps {
  readonly chIn: GainNode;
  readonly routeIn: GainNode;
  /** Everything that feeds `chIn` (channels, and the bus's own link while its insert is gone) connects through this. */
  readonly chMix: OrderedMix;
  /** Everything that feeds `routeIn` (routes from other inserts, and the bus's own channels) connects through this. */
  readonly routeMix: OrderedMix;
  readonly scTap: GainNode;
  readonly preTap: GainNode;
  readonly postTap: GainNode;
  /** chIn → routeIn, or chIn → the master while the insert is gone (never padded: see DelayCompensation). */
  readonly chLink: PadLink;

  constructor(ctx: BaseAudioContext, offline: boolean) {
    this.chIn = new GainNode(ctx);
    this.routeIn = new GainNode(ctx);
    this.chMix = new OrderedMix(ctx, this.chIn);
    this.routeMix = new OrderedMix(ctx, this.routeIn);
    this.scTap = new GainNode(ctx);
    this.preTap = new GainNode(ctx);
    this.postTap = new GainNode(ctx);
    this.chLink = new PadLink(ctx, this.chIn, offline);
  }

  dispose(): void {
    this.chLink.dispose();
    this.chMix.dispose();
    this.routeMix.dispose();
    for (const node of [this.chIn, this.routeIn, this.scTap, this.preTap, this.postTap]) node.disconnect();
  }
}

/** A route between two inserts: tap → level → [pad] → the target's routeIn. */
export class RouteLink {
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
    this.lane = new AutoLane(ctx, targetKey({ kind: 'route', insertId: from, to }), ROUTE_LEVEL_SPEC, level, ROUTE_LEVEL_TAU_SEC);
    this.lane.bind(this.gain.gain);
    this.unregister = core.params.register(this.lane);
    this.tap = route.pre ? source.preTap : source.postTap;
    this.tap.connect(this.gain);
    this.pad = new PadLink(ctx, this.gain, core.offline);
  }

  /** The send level follows what leaves the insert: `seconds` behind the song's clock (see DelayCompensation.out). */
  setShift(seconds: number): void {
    this.lane.shift = seconds;
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
