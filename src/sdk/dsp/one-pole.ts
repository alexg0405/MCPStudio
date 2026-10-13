// One-pole filter / exponential smoother. Allocation-free; usable on any thread.

/**
 * `y += a·(x − y)`: a 6 dB/octave low-pass (and, as `x − y`, the matching high-pass), or a smoother
 * for control values. Set it by cutoff (`a = 1 − e^(−2π·f/fs)`) or by time constant (a step gets 63 %
 * of the way after `seconds`).
 */
export class OnePole {
  private a = 1;
  private y = 0;

  /** Cutoff in Hz (clamped below Nyquist). */
  setCutoff(freq: number, sampleRate: number): this {
    const f = Math.min(Math.max(freq, 0), sampleRate * 0.49);
    this.a = 1 - Math.exp((-2 * Math.PI * f) / sampleRate);
    return this;
  }

  /** Time constant in seconds; 0 follows the input exactly. */
  setTime(seconds: number, sampleRate: number): this {
    this.a = seconds > 0 ? 1 - Math.exp(-1 / (seconds * sampleRate)) : 1;
    return this;
  }

  /** Low-pass output (the smoothed value). */
  process(x: number): number {
    let y = this.y + this.a * (x - this.y);
    // Flush denormals (and NaN) so silence stays cheap.
    if (!(Math.abs(y) > 1e-20)) y = 0;
    this.y = y;
    return y;
  }

  /** High-pass output: what the low-pass removes. */
  highpass(x: number): number {
    return x - this.process(x);
  }

  /** The current output (low-pass state). */
  get value(): number {
    return this.y;
  }

  /** Jumps to `value` (0 by default). */
  reset(value = 0): void {
    this.y = value;
  }
}
