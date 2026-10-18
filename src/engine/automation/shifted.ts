/**
 * A lane as the automation driver sees it when the control sits behind the song's clock (`AutomatableParam.shift`):
 * the driver plans in the song's time (tick → seconds on the transport's timeline) and this moves every time it
 * passes in or reads out by the control's shift, so the breakpoints land on the lane where they are heard with the
 * notes (the channel's events are held back the same amount, see Engine.alignChannels).
 *
 * The shift is read at each call; the owner changes it with the lane's `shift` and tells the driver (`retime()`),
 * which plans the lane again from the next segment.
 */
import type { ParamSpec } from '@agstudio/sdk';
import type { AutomatableParam } from '../param-lane';

/** A lane seen in the song's time: every time passed in or read out is moved by the control's shift. */
export class ShiftedParam implements AutomatableParam {
  /** The shift the driver last planned with. */
  private applied: number;
  private scratch = new Float64Array(64);

  constructor(readonly inner: AutomatableParam) {
    this.applied = inner.shift ?? 0;
  }

  get key(): string {
    return this.inner.key;
  }
  get spec(): ParamSpec {
    return this.inner.spec;
  }
  get base(): number {
    return this.inner.base;
  }
  get driven(): boolean {
    return this.inner.driven;
  }
  get shift(): number {
    return this.inner.shift ?? 0;
  }

  /** True once after the shift changed (the driver then plans the lane again). */
  retimed(): boolean {
    const now = this.shift;
    if (now === this.applied) return false;
    this.applied = now;
    return true;
  }

  cut(at: number): number {
    const sh = this.shift;
    return sh === 0 ? this.inner.cut(at) : this.inner.cut(at + sh) - sh;
  }

  extend(points: ArrayLike<number>): void {
    const sh = this.shift;
    if (sh === 0) {
      this.inner.extend(points);
      return;
    }
    if (this.scratch.length < points.length) this.scratch = new Float64Array(points.length * 2);
    const out = this.scratch;
    for (let i = 0; i + 1 < points.length; i += 2) {
      out[i] = (points[i] as number) + sh;
      out[i + 1] = points[i + 1] as number;
    }
    this.inner.extend(out.subarray(0, points.length - (points.length % 2)));
  }

  release(at: number, ramp?: number): void {
    this.inner.release(at + this.shift, ramp);
  }

  valueAt(time: number): number {
    return this.inner.valueAt(time + this.shift);
  }

  get scheduledUntil(): number {
    return this.inner.scheduledUntil - this.shift;
  }

  start(value: number): void {
    this.inner.start(value);
  }
}
