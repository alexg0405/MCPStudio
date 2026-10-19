import { at, dbToGain, EffectKernel, LookaheadLimiter, Readings, type ParamBlock } from '@agstudio/sdk/worklet';
import { lookaheadFrames, type limiterParams } from './params';

type Params = typeof limiterParams;

/**
 * Look-ahead brickwall limiter (the SDK's `LookaheadLimiter`: true-peak detector, sliding minimum,
 * release smoother, box-filtered ramp, delayed audio) with the plugin's input gain, ceiling and
 * release. The look-ahead delay is reported as latency.
 */
export class LimiterKernel extends EffectKernel<Params> {
  private readonly limiter = new LookaheadLimiter(lookaheadFrames(this.sampleRate));
  /** Look-ahead (attack ramp) in frames. */
  readonly lookahead = this.limiter.lookahead;
  /** Total delay in frames (the reported latency). */
  readonly latency = this.limiter.latency;
  // Cached param conversions.
  private inputDb = Number.NaN;
  private inputGain = 1;
  private ceilingDb = Number.NaN;
  private ceilingGain = 1;
  private releaseMs = Number.NaN;
  /** Gain reduction (dB, ≥ 0) for the editor. */
  private readonly meter = new Readings(this.host, ['gr'] as const);

  override reset(): void {
    this.limiter.reset();
    this.meter.values.gr = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const usesTruePeak = (params.truePeak[0] as number) >= 0.5;
    const limiter = this.limiter;
    limiter.minGain = 1;
    for (let i = 0; i < frameCount; i++) {
      this.updateCachedParams(at(params.input, i), at(params.ceiling, i), at(params.release, i));
      limiter.step(
        (inLeft[i] as number) * this.inputGain,
        (inRight[i] as number) * this.inputGain,
        this.ceilingGain,
        usesTruePeak,
      );
      outLeft[i] = limiter.outL;
      outRight[i] = limiter.outR;
    }
    const minGain = limiter.minGain;
    const reductionDb = minGain < 1 ? -20 * Math.log10(minGain) : 0;
    const shownReductionDb = this.meter.values.gr - (20 * frameCount) / this.sampleRate;
    this.meter.values.gr = reductionDb > shownReductionDb ? reductionDb : shownReductionDb > 0 ? shownReductionDb : 0;
    this.meter.tick(frameCount);
  }

  private updateCachedParams(inputDb: number, ceilingDb: number, releaseMs: number): void {
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
      this.limiter.releaseCoef = 1 - Math.exp(-1000 / (Math.max(0.1, releaseMs) * this.sampleRate));
    }
  }
}
