/**
 * The time being heard, smoothed for drawing. The output's timestamps arrive once per audio callback
 * (about every 21 ms with the large buffer) and each one is a few milliseconds early or late; carried on
 * by the wall clock between them, the estimate jumped by that much at every callback, which made the
 * playhead (and a view scrolling with it) stutter. This follows the timestamps' trend instead: it runs
 * on the wall clock and is pulled gently toward the raw estimate, jumps when they disagree a lot (a
 * seek, a stall, a new device), and never goes back.
 */

/** How quickly it is pulled toward the raw estimate (seconds; about 63 % of an error is gone after this). */
export const CLOCK_TAU = 0.25;
/** A disagreement larger than this (seconds) is real (a seek, a stall): it jumps instead of easing. */
export const CLOCK_RESYNC = 0.06;

/** Smooths the raw heard-time estimates into a time that runs evenly and never goes back. */
export class AudibleClock {
  private t = Number.NaN;
  private at = 0;
  private last = Number.NEGATIVE_INFINITY;

  /** The smoothed time for a raw estimate `raw` (seconds) read at `nowMs` (performance.now()). */
  step(raw: number, nowMs: number): number {
    if (!Number.isFinite(this.t)) {
      this.t = raw;
    } else {
      const dt = Math.max(0, (nowMs - this.at) / 1000);
      const predicted = this.t + dt;
      const err = raw - predicted;
      this.t = Math.abs(err) > CLOCK_RESYNC ? raw : predicted + err * (1 - Math.exp(-dt / CLOCK_TAU));
    }
    this.at = nowMs;
    // What is heard never goes back (a playhead that stepped back blinked).
    if (this.t > this.last) this.last = this.t;
    return this.last;
  }
}
