import type { InsertId } from '@core/model/types';
import type { MeterHandle } from './api';
import { MeterNode, canMeter } from './meter/meter-node';

/** What the metering suite needs from the engine. */
export interface LiveMetersHost {
  readonly ctx: BaseAudioContext;
  /** Offline and disposed engines have nothing to meter. */
  canOpen(): boolean;
  loadModule(url: string): Promise<void>;
  /** The node that carries an insert's output (after its fader), or null for an unknown insert. */
  outputNode(source: InsertId): AudioNode | null;
}

/** The open meters of the metering suite: one worklet node each, taken out of the graph when closed. */
export class LiveMeters {
  private readonly open = new Set<MeterNode>();

  constructor(private readonly host: LiveMetersHost) {}

  /** Opens a meter on an insert's output (the master included), or returns null where metering is not possible. */
  openOn(source: InsertId, opts: { full?: boolean } = {}): MeterHandle | null {
    if (!this.host.canOpen() || !canMeter()) return null;
    const from = this.host.outputNode(source);
    if (!from) return null;
    const meter = new MeterNode(
      this.host.ctx,
      (url) => this.host.loadModule(url),
      from,
      opts,
      (closed) => this.open.delete(closed),
    );
    this.open.add(meter);
    return meter;
  }

  /** Meters that are open (a closed Meters window leaves none). */
  get count(): number {
    return this.open.size;
  }

  /** Closes every meter still open. */
  closeAll(): void {
    for (const meter of [...this.open]) meter.close();
  }
}
