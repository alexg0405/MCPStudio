// Fractional delay line. Allocation-free after construction; usable on any thread.

/**
 * A ring buffer read at fractional delays (in samples) with linear or 4-point cubic (Hermite)
 * interpolation. Write one sample, then read at any delay from 0 up to `maxDelay`.
 */
export class DelayLine {
  private readonly buf: Float32Array;
  private readonly mask: number;
  private w = 0;
  readonly maxDelay: number;

  constructor(maxDelaySamples: number) {
    let size = 4;
    while (size < maxDelaySamples + 4) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.maxDelay = size - 4;
  }

  write(x: number): void {
    this.w = (this.w + 1) & this.mask;
    this.buf[this.w] = x;
  }

  /** The sample written `delay` samples ago (fraction allowed; linear interpolation). */
  read(delay: number): number {
    const d = Math.min(this.maxDelay, Math.max(0, delay));
    const i = Math.floor(d);
    const f = d - i;
    const a = this.buf[(this.w - i) & this.mask] as number;
    const b = this.buf[(this.w - i - 1) & this.mask] as number;
    return a + (b - a) * f;
  }

  /** Like read(), with cubic (Hermite) interpolation: smoother for modulated delays (chorus, vibrato). */
  readCubic(delay: number): number {
    const d = Math.min(this.maxDelay - 1, Math.max(1, delay));
    const i = Math.floor(d);
    const f = d - i;
    const xm1 = this.buf[(this.w - i + 1) & this.mask] as number;
    const x0 = this.buf[(this.w - i) & this.mask] as number;
    const x1 = this.buf[(this.w - i - 1) & this.mask] as number;
    const x2 = this.buf[(this.w - i - 2) & this.mask] as number;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  clear(): void {
    this.buf.fill(0);
  }
}
