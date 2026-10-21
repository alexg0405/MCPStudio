/**
 * Idle parking: keeps what cannot sound out of the audio graph.
 *
 * Chrome processes every node the destination reaches backwards through connections, silent or not, and charges about
 * a quarter of a microsecond for a gain and three for an AudioWorklet kernel on every 128-frame block. A big project
 * is mostly idle at any moment (a few dozen of its two hundred instruments play in a given bar), so the plugins that
 * report that they sleep (the SDK's `Sleeper`) and the mixer chains they feed are cut loose until a note comes:
 *
 * - a channel whose instrument sleeps is taken off its insert's mix (`ChannelStrip.park`), which stops the instrument
 *   and the channel's volume, pan and mute nodes from being processed;
 * - an insert whose inputs are all parked, whose effects are asleep (or, for effects that cannot say, have had silence
 *   for as long as they ring) is cut off between its last effect and its sidechain tap (`InsertStrip.park`), which
 *   stops the effect chain from being processed.
 *
 * Waking is immediate and ahead of the sound: a note handed to a sleeping plugin wakes it first (its scheduled time is at
 * least a lookahead away; a live note is sound at once, and the reconnection takes effect with the note), which
 * calls `changed()` here, and the wiring is put back synchronously, from the inserts outwards. Parking only happens on
 * the timer: falling asleep needs no hurry. Offline renders never park, so a render is the same graph it always was.
 */
import type { ChannelId, InsertId } from '@core/model/types';
import type { ChannelStrip } from './channel-strip';
import type { IdleSignals } from './engine-core';
import type { MixerGraph } from './mixer-graph';
import { InsertParkingPlanner, type ChannelFeed } from './parking-plan';

/** How often sleepers are looked at for parking, milliseconds. Waking does not wait for it. */
const PARKING_TICK_MS = 250;

/**
 * How long an instrument must have been asleep before its channel is parked (seconds). Plugins made of native nodes
 * fall asleep a moment after their last voice, and a channel that plays short sounds again and again would be taken out
 * and put back every few hundred milliseconds for nothing.
 */
const PARK_AFTER_SEC = 0.5;

/** What is parked right now (diagnostics, tests and the performance scripts). */
export interface ParkingCounts {
  channels: number;
  inserts: number;
}

/** The engine's idle parking (see the file comment). */
export class IdleParking implements IdleSignals {
  private readonly planner = new InsertParkingPlanner();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isEvaluating = false;
  /** Since when (context time) each channel's instrument has been asleep. */
  private readonly asleepSince = new Map<ChannelStrip, number>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly strips: ReadonlyMap<ChannelId, ChannelStrip>,
    private readonly mixer: MixerGraph,
  ) {}

  /** Starts looking for what may be parked, every tick. */
  start(): void {
    this.timer ??= setInterval(() => this.changed(), PARKING_TICK_MS);
  }

  /** Stops looking (the engine is being shut down). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get counts(): ParkingCounts {
    let channels = 0;
    for (const strip of this.strips.values()) if (strip.parked) channels++;
    let inserts = 0;
    for (const strip of this.mixer.parkingView.strips.values()) if (strip.parked) inserts++;
    return { channels, inserts };
  }

  /** Works out what may be parked and what must come back, and does it. */
  changed(): void {
    if (this.isEvaluating) return;
    this.isEvaluating = true;
    try {
      this.evaluate();
    } finally {
      this.isEvaluating = false;
    }
  }

  /** Whether the channel is, or may now become, parked: its instrument has slept for a while (a parked one needs only to be asleep). */
  private staysParked(strip: ChannelStrip, now: number): boolean {
    if (!strip.isIdle) {
      this.asleepSince.delete(strip);
      return false;
    }
    const since = this.asleepSince.get(strip) ?? now;
    this.asleepSince.set(strip, since);
    return strip.parked || now - since >= PARK_AFTER_SEC;
  }

  private evaluate(): void {
    const now = this.ctx.currentTime;
    const feeds = new Map<InsertId, ChannelFeed>();
    const parkChannels: ChannelStrip[] = [];
    const unparkChannels: ChannelStrip[] = [];
    for (const strip of this.strips.values()) {
      const feed = feedOf(feeds, strip.outputId);
      if (!strip.parked) feed.attached++;
      const isStaying = this.staysParked(strip, now);
      if (!isStaying) feed.silent = false;
      if (isStaying && !strip.parked) parkChannels.push(strip);
      else if (!isStaying && strip.parked) unparkChannels.push(strip);
    }
    if (this.asleepSince.size > this.strips.size) {
      const current = new Set(this.strips.values());
      for (const strip of this.asleepSince.keys()) if (!current.has(strip)) this.asleepSince.delete(strip);
    }
    const plan = this.planner.plan(this.mixer.parkingView, feeds, now);
    // Waking goes from the inserts out to the channels, so the path is open before sound can come down it; parking the other way.
    for (const insert of plan.unpark) insert.unpark();
    for (const channel of unparkChannels) channel.unpark();
    for (const channel of parkChannels) channel.park();
    for (const insert of plan.park) insert.park();
  }
}

/** The entry of an insert in the channel feeds (a channel that routes nowhere known is counted under its own output id). */
function feedOf(feeds: Map<InsertId, ChannelFeed>, id: InsertId): ChannelFeed {
  let feed = feeds.get(id);
  if (!feed) {
    feed = { attached: 0, silent: true };
    feeds.set(id, feed);
  }
  return feed;
}
