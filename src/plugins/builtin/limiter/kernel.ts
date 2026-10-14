import { at, dbToGain, EffectKernel, Readings, TruePeak, type ParamBlock } from '@agstudio/sdk/worklet';
import { latencyFrames, lookaheadFrames, type limiterParams } from './params';

type P = typeof limiterParams;

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
 * Look-ahead brickwall limiter. Per frame (stereo-linked): the detector (true peak, 4×
 * oversampled, or sample peak with the same timing) gives the gain the signal needs to stay under
 * the ceiling; a sliding minimum holds that gain over the look-ahead window plus the detector's
 * span, a release smoother lets it come back up slowly (never faster than the requirement allows),
 * and a box filter as long as the look-ahead turns each drop into a smooth ramp that ends exactly
 * where the peak (and every sample its reconstruction depends on) passes. The audio is delayed by
 * the same amount, which the plugin reports as latency.
 *
 * Why it can't overshoot: a peak's requirement r enters the minimum at frame k and stays for W
 * frames; the box average is ≤ r from k + A − 1 to k + W − 1, and the delayed samples the peak
 * depends on pass in exactly that range (D = A + 14, W = A + 15).
 */
export class LimiterKernel extends EffectKernel<P> {
  /** Look-ahead (attack ramp) in frames. */
  readonly lookahead = lookaheadFrames(this.sampleRate);
  /** Total delay in frames (the reported latency). */
  readonly latency = latencyFrames(this.sampleRate);
  private readonly window = this.latency + 1;
  private readonly detL = new TruePeak();
  private readonly detR = new TruePeak();
  // Sliding minimum: a monotonic deque of (value, frame) in rings.
  private readonly dqValue = new Float64Array(this.window + 1);
  private readonly dqFrame = new Float64Array(this.window + 1);
  private dqHead = 0;
  private dqSize = 0;
  private frame = 0;
  // Box filter over the held gain.
  private readonly box = new Float64Array(this.lookahead).fill(1);
  private boxPos = 0;
  private boxSum = this.lookahead;
  private resum = RESUM_EVERY;
  /** The minimum after the release smoother. */
  private held = 1;
  // The audio delay line (one ring per channel).
  private readonly delayL = new Float32Array(this.latency);
  private readonly delayR = new Float32Array(this.latency);
  private delayPos = 0;
  // Cached param conversions.
  private inputDb = Number.NaN;
  private inputGain = 1;
  private ceilingDb = Number.NaN;
  private ceilingGain = 1;
  private releaseMs = Number.NaN;
  private releaseCoef = 0;
  /** Gain reduction (dB, ≥ 0) for the editor. */
  private readonly meter = new Readings(this.host, ['gr'] as const);

  override reset(): void {
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
    this.meter.values.gr = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const truePeak = (p.truePeak[0] as number) >= 0.5;
    const dl = this.detL;
    const dr = this.detR;
    const margin = truePeak ? TRUE_PEAK_MARGIN : SAMPLE_MARGIN;
    let minGain = 1;
    for (let i = 0; i < n; i++) {
      this.params(at(p.input, i), at(p.ceiling, i), at(p.release, i));
      const xl = (inL[i] as number) * this.inputGain;
      const xr = (inR[i] as number) * this.inputGain;
      const el = truePeak ? dl.process(xl) : dl.sample(xl);
      const er = truePeak ? dr.process(xr) : dr.sample(xr);
      const peak = el > er ? el : er;
      const limit = this.ceilingGain * margin;
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
      if (g < minGain) minGain = g;
      // The delayed audio, at the gain its peaks need.
      const pos = this.delayPos;
      const yl = this.delayL[pos] as number;
      const yr = this.delayR[pos] as number;
      this.delayL[pos] = xl;
      this.delayR[pos] = xr;
      this.delayPos = pos + 1 < this.latency ? pos + 1 : 0;
      outL[i] = yl * g;
      outR[i] = yr * g;
    }
    const gr = minGain < 1 ? -20 * Math.log10(minGain) : 0;
    const shown = this.meter.values.gr - (20 * n) / this.sampleRate;
    this.meter.values.gr = gr > shown ? gr : shown > 0 ? shown : 0;
    this.meter.tick(n);
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

  private params(inputDb: number, ceilingDb: number, releaseMs: number): void {
    if (inputDb !== this.inputDb) {
      this.inputDb = inputDb;
      this.inputGain = dbToGain(inputDb);
    }
    if (ceilingDb !== this.ceilingDb) {
      this.ceilingDb = ceilingDb;
      this.ceilingGain = dbToGain(ceilingDb);
    }
    if (releaseMs !== this.releaseMs) {
      this.releaseMs = releaseMs;
      this.releaseCoef = 1 - Math.exp(-1000 / (Math.max(0.1, releaseMs) * this.sampleRate));
    }
  }
}
