/**
 * Plays automation clips: follows the transport's timeline and drives the registered automatable
 * params (engine/param-lane.ts) with ramps scheduled ahead, like notes.
 *
 * Contract (M9 fills it in):
 * - `update(project, view)` is called after every document reconcile and transport-view change;
 * - as a TransportObserver it plans each segment before the segment's notes go out, so plugins that
 *   read `valueAt(noteTime)` at noteOn see the curve;
 * - `touch(key, on)`: a knob drag, a stream of MIDI CCs or recording takes the control over; the
 *   driver releases the param and ramps back to the curve when the touch ends;
 * - `readValue(key, time)` answers knobs that follow automation (NaN when not driven).
 */
import type { Project } from '@core/model/types';
import type { TransportView } from '../api';
import type { ParamRegistry } from '../param-lane';
import type { Segment } from '../sched/core';
import type { TransportObserver } from '../sched/transport';

export interface DriverDeps {
  readonly ctx: BaseAudioContext;
  readonly params: ParamRegistry;
  readonly offline: boolean;
}

export class AutomationDriver implements TransportObserver {
  private readonly touched = new Set<string>();

  constructor(private readonly deps: DriverDeps) {}

  /** The document or the transport view changed. */
  update(_project: Project, _view: TransportView): void {}

  started(_tick: number, _time: number): void {}

  segment(_seg: Segment, _wrapped: boolean): void {}

  reanchored(_time: number, _timelineChanged: boolean): void {}

  seeked(_tick: number, _time: number): void {}

  stopped(_time: number): void {}

  touch(key: string, on: boolean): void {
    if (on) this.touched.add(key);
    else this.touched.delete(key);
  }

  /** The automated value of `key` at `time` (spec units), or NaN when automation doesn't drive it. */
  readValue(key: string, time: number): number {
    const p = this.deps.params.newest(key);
    return p && p.driven ? p.valueAt(time) : Number.NaN;
  }

  dispose(): void {
    this.touched.clear();
  }
}
