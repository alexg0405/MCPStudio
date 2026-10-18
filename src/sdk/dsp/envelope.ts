// Envelope follower (attack/release ballistics). Allocation-free; usable on any thread.

/** What an envelope follower tracks: the peak of |x|, or the RMS level. */
export type EnvelopeMode = 'peak' | 'rms';

/**
 * Follows the level of a signal with separate attack (rising) and release (falling) time constants:
 * `peak` tracks |x|, `rms` the square root of the smoothed mean square. It smooths any non-negative
 * control signal too: feed it a compressor's gain reduction in dB to get the classic "smooth
 * branching" detector. Times are time constants (63 % of a step), 0 = instant.
 */
export class EnvelopeFollower {
  private attackCoef = 0;
  private releaseCoef = 0;
  private state = 0;
  private rms: boolean;

  constructor(
    private readonly sampleRate: number,
    attackMs = 1,
    releaseMs = 100,
    mode: EnvelopeMode = 'peak',
  ) {
    this.rms = mode === 'rms';
    this.setTimes(attackMs, releaseMs);
  }

  setTimes(attackMs: number, releaseMs: number): this {
    this.attackCoef = coefficient(attackMs, this.sampleRate);
    this.releaseCoef = coefficient(releaseMs, this.sampleRate);
    return this;
  }

  setMode(mode: EnvelopeMode): this {
    const rms = mode === 'rms';
    if (rms !== this.rms) {
      // Keep the level continuous across the switch.
      this.state = rms ? this.state * this.state : Math.sqrt(this.state);
      this.rms = rms;
    }
    return this;
  }

  /** Feeds one sample and returns the envelope (same units as |x|). */
  process(x: number): number {
    const v = this.rms ? x * x : x < 0 ? -x : x;
    const c = v > this.state ? this.attackCoef : this.releaseCoef;
    let s = v + c * (this.state - v);
    if (!(s > 1e-30)) s = 0; // denormals and NaN
    this.state = s;
    return this.rms ? Math.sqrt(s) : s;
  }

  /** The current envelope. */
  get value(): number {
    return this.rms ? Math.sqrt(this.state) : this.state;
  }

  reset(): void {
    this.state = 0;
  }
}

function coefficient(ms: number, sampleRate: number): number {
  return ms > 0 ? Math.exp(-1 / ((ms / 1000) * sampleRate)) : 0;
}
