import { at, dbToGain, EffectKernel, LookaheadLimiter, Readings, type ParamBlock } from '@agstudio/sdk/worklet';
import { lookaheadFrames, type limiterParams } from './params';

type P = typeof limiterParams;

/**
 * Look-ahead brickwall limiter (the SDK's `LookaheadLimiter`: true-peak detector, sliding minimum,
 * release smoother, box-filtered ramp, delayed audio) with the plugin's input gain, ceiling and
 * release. The look-ahead delay is reported as latency.
 */
export class LimiterKernel extends EffectKernel<P> {
  private readonly core = new LookaheadLimiter(lookaheadFrames(this.sampleRate));
  /** Look-ahead (attack ramp) in frames. */
  readonly lookahead = this.core.lookahead;
  /** Total delay in frames (the reported latency). */
  readonly latency = this.core.latency;
  // Cached param conversions.
  private inputDb = Number.NaN;
  private inputGain = 1;
  private ceilingDb = Number.NaN;
  private ceilingGain = 1;
  private releaseMs = Number.NaN;
  /** Gain reduction (dB, ≥ 0) for the editor. */
  private readonly meter = new Readings(this.host, ['gr'] as const);

  override reset(): void {
    this.core.reset();
    this.meter.values.gr = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const truePeak = (p.truePeak[0] as number) >= 0.5;
    const core = this.core;
    core.minGain = 1;
    for (let i = 0; i < n; i++) {
      this.params(at(p.input, i), at(p.ceiling, i), at(p.release, i));
      core.step((inL[i] as number) * this.inputGain, (inR[i] as number) * this.inputGain, this.ceilingGain, truePeak);
      outL[i] = core.outL;
      outR[i] = core.outR;
    }
    const minGain = core.minGain;
    const gr = minGain < 1 ? -20 * Math.log10(minGain) : 0;
    const shown = this.meter.values.gr - (20 * n) / this.sampleRate;
    this.meter.values.gr = gr > shown ? gr : shown > 0 ? shown : 0;
    this.meter.tick(n);
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
      this.core.releaseCoef = 1 - Math.exp(-1000 / (Math.max(0.1, releaseMs) * this.sampleRate));
    }
  }
}
