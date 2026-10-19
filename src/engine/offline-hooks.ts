import type { ChannelId } from '@core/model/types';
import type { ChannelStrip } from './channel-strip';
import type { LauncherLink } from './launcher-link';
import type { SampleResidency } from './sample-residency';
import type { Transport } from './sched/transport';
import type { TransportDriver } from './transport-driver';

/** What the offline hooks need from the engine. */
export interface OfflineHooksDeps {
  ctx: BaseAudioContext;
  transport: Transport;
  driver: TransportDriver;
  launcherLink: LauncherLink;
  residency: SampleResidency;
  strips: ReadonlyMap<ChannelId, ChannelStrip>;
}

/**
 * What an offline render (export, freeze, tests) calls on the engine instead of the scheduler clock: the render loop
 * starts the transport on the virtual clock, pumps it chunk by chunk (nothing plans ahead on its own, there is no
 * timer), and makes the clips' samples ready before they are scheduled so a render never depends on timing.
 */
export class OfflineHooks {
  constructor(private readonly deps: OfflineHooksDeps) {}

  /** Starts the transport on the virtual clock at `fromTick`, at context time `at` (then call `pump` per chunk). */
  start(fromTick: number, at: number): void {
    this.deps.driver.replan();
    this.deps.transport.start(fromTick, at);
  }

  /** Plans (and hands to the graph) everything the transport plays up to context time `horizon`. */
  pump(horizon: number): void {
    this.deps.launcherLink.sync();
    this.deps.transport.pump(horizon);
  }

  /** The music ends at `time` (context seconds): notes still held are released there. */
  end(time: number): void {
    this.deps.transport.releaseHeld(time);
  }

  /**
   * Everything the clips scheduled up to `horizon` (context time) play from is decoded (and stretched) before they
   * are scheduled, so a render never depends on timing.
   */
  async prepare(horizon: number): Promise<void> {
    const { transport, ctx, residency, driver } = this.deps;
    // Finished voices let go of their buffers (so what the render has passed can be evicted).
    for (const strip of this.deps.strips.values()) strip.sweep();
    if (driver.view.mode !== 'song') return;
    const fromTick = transport.tickAt(ctx.currentTime).tick;
    const toTick = transport.tickAt(horizon).tick;
    await residency.ensure(fromTick, toTick);
  }

  /** Like `prepare`, for song ticks [fromTick, toTick] (before the transport starts). */
  async prepareTicks(fromTick: number, toTick: number): Promise<void> {
    if (this.deps.driver.view.mode !== 'song') return;
    await this.deps.residency.ensure(fromTick, toTick);
  }
}
