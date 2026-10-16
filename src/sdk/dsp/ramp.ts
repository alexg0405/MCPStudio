// Control-rate ramp: a derived value that moves in a straight line to each new target. Allocation-free; usable on any thread.

/**
 * A value derived from a param (a dB-to-gain factor, a time constant's coefficient) is worth
 * recomputing only every few frames, not on every frame that the param changes. At each control point
 * `aim(target, frames)` sets the next target when the param has changed; the kernel then steps the value
 * by `slope` per frame (a local, so the held case writes nothing per frame) and `land()` ends the interval
 * exactly on the target. A held target has a slope of 0, so the value is the target bit for bit.
 *
 * ```ts
 * // per control point (every 32 frames), then per frame, then at the end of the interval:
 * if (gainDb !== lastDb) this.gain.aim(dbToGain(gainDb), frames);
 * let g = this.gain.value;
 * const dg = this.gain.slope;
 * for (...) { g += dg; out[i] = x[i] * g; }
 * this.gain.land();
 * ```
 */
export class Ramp {
  private v = Number.NaN;
  private to = Number.NaN;
  private d = 0;

  /** Heads for `target` over the next `frames` frames. The very first target is taken at once. */
  aim(target: number, frames: number): void {
    if (this.v !== this.v) this.v = target;
    this.to = target;
    this.d = (target - this.v) / frames;
  }

  /** The value at the start of the interval. */
  get value(): number {
    return this.v;
  }

  /** The change per frame over the interval (0 when the target is held). */
  get slope(): number {
    return this.d;
  }

  /** Ends the interval on the target exactly. */
  land(): void {
    this.v = this.to;
    this.d = 0;
  }
}
