// A sample ring buffer with the two kinds of read the harmonizer's voices make, both cheaper than the SDK's DelayLine
// because the hot loops here know more about what they read. No allocation after construction.

export class SampleRing {
  private readonly buffer: Float32Array;
  private readonly mask: number;
  private newest = 0;
  /** The longest whole delay `readCubic` and `readWeighted` accept, frames. */
  readonly maxDelay: number;

  constructor(maxDelayFrames: number) {
    let size = 8;
    while (size < maxDelayFrames + 8) size <<= 1;
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
    this.maxDelay = size - 8;
  }

  write(sample: number): void {
    this.newest = (this.newest + 1) & this.mask;
    this.buffer[this.newest] = sample;
  }

  /** The sample written `wholeDelay` frames ago (0 = the one just written). */
  at(wholeDelay: number): number {
    return this.buffer[(this.newest - wholeDelay) & this.mask] as number;
  }

  /** The signal `delay` frames ago (fractions allowed), by cubic (Hermite) interpolation, as DelayLine.readCubic. */
  readCubic(delay: number): number {
    const limited = delay < 1 ? 1 : delay > this.maxDelay ? this.maxDelay : delay;
    const whole = Math.floor(limited);
    const fraction = limited - whole;
    const base = this.newest - whole;
    const before = this.buffer[(base + 1) & this.mask] as number;
    const here = this.buffer[base & this.mask] as number;
    const next = this.buffer[(base - 1) & this.mask] as number;
    const after = this.buffer[(base - 2) & this.mask] as number;
    const slope = 0.5 * (next - before);
    const curve = before - 2.5 * here + 2 * next - 0.5 * after;
    const bend = 0.5 * (after - before) + 1.5 * (here - next);
    return ((bend * fraction + curve) * fraction + slope) * fraction + here;
  }

  /**
   * A cubic read at a whole delay with the four interpolation weights worked out beforehand (see `hermiteWeights`):
   * for a read at a fixed delay, which a grain makes, the weights are the same every frame.
   */
  readWeighted(wholeDelay: number, weights: Float64Array, weightsAt: number): number {
    const base = this.newest - wholeDelay;
    return (
      (this.buffer[(base + 1) & this.mask] as number) * (weights[weightsAt] as number) +
      (this.buffer[base & this.mask] as number) * (weights[weightsAt + 1] as number) +
      (this.buffer[(base - 1) & this.mask] as number) * (weights[weightsAt + 2] as number) +
      (this.buffer[(base - 2) & this.mask] as number) * (weights[weightsAt + 3] as number)
    );
  }

  clear(): void {
    this.buffer.fill(0);
  }
}

/**
 * Writes the four weights of a cubic (Hermite) read at the fraction `fraction` (0-1) after the whole delay into
 * `weights[at..at + 3]`, for the samples one frame newer than the whole delay, at it, one older and two older.
 * They sum to 1 and match `SampleRing.readCubic` at that fraction.
 */
export function hermiteWeights(fraction: number, weights: Float64Array, at: number): void {
  const squared = fraction * fraction;
  const cubed = squared * fraction;
  weights[at] = -0.5 * fraction + squared - 0.5 * cubed;
  weights[at + 1] = 1 - 2.5 * squared + 1.5 * cubed;
  weights[at + 2] = 0.5 * fraction + 2 * squared - 1.5 * cubed;
  weights[at + 3] = -0.5 * squared + 0.5 * cubed;
}
