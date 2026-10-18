/**
 * A meter that survives engine reboots. `EngineHost` hands one out per `openMeter`: it reads whichever engine runs
 * now (a deferred host starts with a stand-in, a reboot swaps the engine), opening the real meter on the first read
 * after the engine changed, and takes the old engine's meter away. Read `readings` (and the other arrays) every frame
 * rather than keeping them: they belong to the current engine's meter.
 */
import type { InsertId } from '@core/model/types';
import type { EngineApi, MeterHandle } from '@engine/api';
import { initReadings, plainViews, R, type MeterViews } from '@engine/meter/layout';

export class MeterLease implements MeterHandle {
  private engine: EngineApi | null = null;
  private inner: MeterHandle | null = null;
  private full: boolean;
  private closed = false;
  private resetsWhileAway = 0;
  /** What reads while there is no meter (no engine yet, a rebooting one): nothing measured. */
  private readonly empty: MeterViews = plainViews();

  constructor(
    private readonly current: () => EngineApi,
    private readonly source: InsertId,
    opts: { full?: boolean },
    private readonly onClose: (l: MeterLease) => void,
  ) {
    this.full = !!opts.full;
    initReadings(this.empty.readings);
  }

  /** The meter of the engine running now (made when the engine changed). */
  private bind(): MeterHandle | null {
    if (this.closed) return null;
    const engine = this.current();
    if (engine !== this.engine) {
      this.inner?.close();
      this.engine = engine;
      this.inner = engine.openMeter?.(this.source, { full: this.full }) ?? null;
    }
    return this.inner;
  }

  get readings(): Float64Array {
    return this.bind()?.readings ?? this.empty.readings;
  }
  get history(): Float32Array {
    return this.bind()?.history ?? this.empty.history;
  }
  get spectrum(): Float32Array {
    return this.bind()?.spectrum ?? this.empty.spectrum;
  }
  get scope(): Float32Array {
    return this.bind()?.scope ?? this.empty.scope;
  }
  get sampleRate(): number {
    return this.bind()?.sampleRate ?? 0;
  }
  get active(): boolean {
    return this.bind()?.active ?? false;
  }
  get blocks(): number {
    return this.bind()?.blocks ?? 0;
  }
  /** How often the meter was asked to restart (also while there was no meter yet). */
  get resets(): number {
    return this.resetsWhileAway;
  }

  setDetail(full: boolean): void {
    this.full = full;
    this.inner?.setDetail(full);
    this.empty.readings[R.detail] = full ? 1 : 0;
  }

  reset(): void {
    this.resetsWhileAway++;
    this.bind()?.reset();
  }

  close(): void {
    if (this.closed) return;
    this.inner?.close();
    this.inner = null;
    this.closed = true;
    this.onClose(this);
  }
}
