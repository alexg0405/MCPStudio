// A look-ahead brickwall limiter core, one stereo frame at a time. Allocation-free; usable on any thread.
import { TruePeak } from './true-peak';

/**
 * Head-room under the ceiling. Sample peaks are exact (the margin only absorbs float rounding);
 * true peaks between samples can move by a hair where a deeper gain ramp starts next to a peak, so
 * the true-peak target sits 0.05 dB lower.
 */
const SAMPLE_MARGIN = 1 - 1e-6;
const TRUE_PEAK_MARGIN = Math.pow(10, -0.05 / 20);
/** The box filter's running sum is recomputed this often (no floating-point drift). */
const RESUM_EVERY = 1 << 16;

/**
 * Frames the true-peak detector adds to the look-ahead: it sees a sample 8 frames after it arrives,
 * and the point it reconstructs between two samples depends on the 7 before and 8 after them, so
 * the gain is held flat over all of them.
 */
export const LIMITER_DETECTOR_FRAMES = 14;

/**
 * Look-ahead brickwall limiter. Per frame (stereo-linked): the detector (true peak, 4×
 * oversampled, or sample peak with the same timing) gives the gain the signal needs to stay under
 * the limit, a sliding minimum holds that gain over the look-ahead window plus the detector's
 * span, a release smoother lets it come back up slowly (never faster than the requirement allows),
 * and a box filter as long as the look-ahead turns each drop into a smooth ramp that ends exactly
 * where the peak (and every sample its reconstruction depends on) passes. The audio is delayed by
 * the same amount (`latency` frames).
 *
 * Why it can't overshoot: a peak's requirement r enters the minimum at frame k and stays for W
 * frames; the box average is ≤ r from k + A − 1 to k + W − 1, and the delayed samples the peak
 * depends on pass in exactly that range (D = A + 14, W = A + 15).
 *
 * Call `step` once per frame, read `outL`/`outR`; `minGain` is the deepest gain of the frames since
 * it was last set back to 1 (for a gain-reduction meter).
 */
export class LookaheadLimiter {
  /** Total delay in frames. */
  readonly latency: number;
  /** The release smoother's coefficient (1 − exp(−1/(release·rate))); set it from the release time. */
  releaseCoef = 0;
  /** Delayed, limited output of the last `step`. */
  outL = 0;
  outR = 0;
  /** Deepest gain applied since the caller last set it to 1. */
  minGain = 1;
  private readonly window: number;
  private readonly detL = new TruePeak();
  private readonly detR = new TruePeak();
  // Sliding minimum: a monotonic deque of (value, frame) in rings.
  private readonly dqValue: Float64Array;
  private readonly dqFrame: Float64Array;
  private dqHead = 0;
  private dqSize = 0;
  private frame = 0;
  // Box filter over the held gain.
  private readonly box: Float64Array;
  private boxPos = 0;
  private boxSum: number;
  private resum = RESUM_EVERY;
  /** The minimum after the release smoother. */
  private held = 1;
  // The audio delay line (one ring per channel).
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private delayPos = 0;

  /** `lookahead`: frames of the attack ramp. */
  constructor(readonly lookahead: number) {
    this.latency = lookahead + LIMITER_DETECTOR_FRAMES;
    this.window = this.latency + 1;
    this.dqValue = new Float64Array(this.window + 1);
    this.dqFrame = new Float64Array(this.window + 1);
    this.box = new Float64Array(lookahead).fill(1);
    this.boxSum = lookahead;
    this.delayL = new Float32Array(this.latency);
    this.delayR = new Float32Array(this.latency);
  }

  reset(): void {
    this.detL.reset();
    this.detR.reset();
    this.dqHead = 0;
    this.dqSize = 0;
    this.box.fill(1);
    this.boxSum = this.lookahead;
    this.boxPos = 0;
    this.held = 1;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.delayPos = 0;
    this.minGain = 1;
  }

  /**
   * One frame: `ceiling` is the linear level the output must stay under; `truePeak` also catches the
   * peaks between samples (and takes the 0.05 dB margin for them).
   */
  step(xl: number, xr: number, ceiling: number, truePeak: boolean): void {
    const el = truePeak ? this.detL.process(xl) : this.detL.sample(xl);
    const er = truePeak ? this.detR.process(xr) : this.detR.sample(xr);
    const peak = el > er ? el : er;
    const limit = ceiling * (truePeak ? TRUE_PEAK_MARGIN : SAMPLE_MARGIN);
    const need = peak > limit ? limit / peak : 1;
    // Hold the requirement over the window, then release slowly.
    const m = this.minimum(need);
    this.held = m < this.held ? m : this.held + (m - this.held) * this.releaseCoef;
    // Ramp it in over the look-ahead.
    const old = this.box[this.boxPos] as number;
    this.box[this.boxPos] = this.held;
    this.boxPos = this.boxPos + 1 < this.lookahead ? this.boxPos + 1 : 0;
    this.boxSum += this.held - old;
    if (--this.resum <= 0) this.recomputeSum();
    let g = this.boxSum / this.lookahead;
    if (g > 1) g = 1;
    if (g < this.minGain) this.minGain = g;
    // The delayed audio, at the gain its peaks need.
    const pos = this.delayPos;
    const yl = this.delayL[pos] as number;
    const yr = this.delayR[pos] as number;
    this.delayL[pos] = xl;
    this.delayR[pos] = xr;
    this.delayPos = pos + 1 < this.latency ? pos + 1 : 0;
    this.outL = yl * g;
    this.outR = yr * g;
  }

  /** Pushes a gain requirement; returns the smallest of the last `window` ones. */
  private minimum(value: number): number {
    const cap = this.dqValue.length;
    const f = this.frame++;
    // Drop larger values from the back: they can never be the minimum again.
    while (this.dqSize > 0) {
      const back = (this.dqHead + this.dqSize - 1) % cap;
      if ((this.dqValue[back] as number) < value) break;
      this.dqSize--;
    }
    const at = (this.dqHead + this.dqSize) % cap;
    this.dqValue[at] = value;
    this.dqFrame[at] = f;
    this.dqSize++;
    // Drop what slid out of the window from the front.
    while ((this.dqFrame[this.dqHead] as number) <= f - this.window) {
      this.dqHead = (this.dqHead + 1) % cap;
      this.dqSize--;
    }
    return this.dqValue[this.dqHead] as number;
  }

  private recomputeSum(): void {
    this.resum = RESUM_EVERY;
    let s = 0;
    for (let i = 0; i < this.box.length; i++) s += this.box[i] as number;
    this.boxSum = s;
  }
}
