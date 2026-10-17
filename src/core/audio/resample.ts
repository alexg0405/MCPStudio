/**
 * Sample-rate conversion by windowed-sinc interpolation, pure (no DOM; Node, Worker or main thread). Each output frame is
 * computed on its own from the source samples around its exact position (`frame × srcRate / dstRate`), so converting
 * a stretch in pieces gives the same samples as converting it whole: a long song can be converted a block at a time
 * with no seam. 64 taps (32 each side), a Blackman–Harris window, the cut-off at the lower of the two Nyquist
 * frequencies (so a higher source rate is filtered before it is thinned); the sinc is tabulated at 4096 sub-sample
 * positions and the nearest is used (a position error under 1/8000 of a sample, about −85 dB).
 */

const PHASES = 4096;
const HALF = 32;

function blackmanHarris(x: number): number {
  // x in [-1, 1].
  if (x <= -1 || x >= 1) return 0;
  const t = Math.PI * (x + 1);
  return 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
}

export class Resampler {
  /** Source frames per output frame. */
  readonly step: number;
  /** Taps each side of a position (more than 32 when the source rate is the higher one). */
  readonly half: number;
  private readonly taps: number;
  private readonly table: Float32Array;

  constructor(
    readonly srcRate: number,
    readonly dstRate: number,
  ) {
    this.step = srcRate / dstRate;
    // Cut-off as a fraction of the source's Nyquist: all of it when upsampling, the destination's when thinning.
    const fc = Math.min(1, dstRate / srcRate) * 0.985;
    this.half = Math.ceil(HALF / Math.min(1, dstRate / srcRate));
    this.taps = this.half * 2;
    this.table = new Float32Array(PHASES * this.taps);
    for (let ph = 0; ph < PHASES; ph++) {
      const frac = ph / PHASES;
      let sum = 0;
      const row = ph * this.taps;
      for (let k = 0; k < this.taps; k++) {
        // The tap at source index (center − half + 1 + k) sits at x = that index − (center + frac) from the position.
        const x = k - this.half + 1 - frac;
        const arg = Math.PI * fc * x;
        const sinc = x === 0 ? fc : Math.sin(arg) / (Math.PI * x);
        const w = sinc * blackmanHarris(x / this.half);
        this.table[row + k] = w;
        sum += w;
      }
      // Unit gain at DC for every position.
      for (let k = 0; k < this.taps; k++) this.table[row + k] = (this.table[row + k] as number) / sum;
    }
  }

  /** The source frames [from, to) that converting output frames [start, start + n) reads. */
  need(start: number, n: number): { from: number; to: number } {
    const a = Math.floor(start * this.step) - this.half + 1;
    const b = Math.floor((start + n - 1) * this.step) + this.half + 2;
    return { from: a, to: b };
  }

  /**
   * Converts output frames [start, start + n) into `out[0..n)`. `src[i]` is source frame `srcStart + i`; it must cover
   * `need(start, n)` (frames outside it are read as zeros).
   */
  convert(src: Float32Array, srcStart: number, out: Float32Array, start: number, n: number): void {
    const taps = this.taps;
    const table = this.table;
    const len = src.length;
    for (let j = 0; j < n; j++) {
      // The position, rounded to the nearest 1/4096 of a source frame.
      const q = Math.round((start + j) * this.step * PHASES);
      const center = Math.floor(q / PHASES);
      const row = (q - center * PHASES) * taps;
      let i0 = center - this.half + 1 - srcStart;
      let acc = 0;
      if (i0 >= 0 && i0 + taps <= len) {
        for (let k = 0; k < taps; k++) acc += (table[row + k] as number) * (src[i0 + k] as number);
      } else {
        for (let k = 0; k < taps; k++, i0++) if (i0 >= 0 && i0 < len) acc += (table[row + k] as number) * (src[i0] as number);
      }
      out[j] = acc;
    }
  }
}
