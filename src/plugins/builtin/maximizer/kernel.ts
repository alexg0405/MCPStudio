import {
  at,
  dbToGain,
  EffectKernel,
  LookaheadLimiter,
  Oversampler,
  Readings,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { lookaheadFrames, MAX_CLIP_DB, type maximizerParams } from './params';

type Params = typeof maximizerParams;

/** The soft clip runs at 2× the sample rate, so what it adds does not fold back into the highs (4× measured the same, at twice the cost; none folded a little more of it back). */
const OVERSAMPLING = 2;
/** Below this the clip is off (and the audio skips the oversampler). */
const CLIP_OFF_DB = 0.05;

/**
 * The soft clip curve: the signal passes untouched up to `lo`, then bends along a smooth cubic (the
 * slope eases from 1 to 0) until `top` (the level the first stage never lets the audio past), where
 * the output is exactly `ceil`; anything above stays at `ceil`. Odd-symmetric. `span` is `top − lo`.
 */
export function softClipShape(
  sample: number,
  kneeStart: number,
  holdLevel: number,
  ceiling: number,
  kneeSpan: number,
): number {
  const magnitude = sample < 0 ? -sample : sample;
  if (magnitude <= kneeStart) return sample;
  let shaped: number;
  if (magnitude >= holdLevel) shaped = ceiling;
  else {
    const kneeProgress = (magnitude - kneeStart) / kneeSpan;
    const kneeProgressSquared = kneeProgress * kneeProgress;
    const kneeProgressCubed = kneeProgressSquared * kneeProgress;
    shaped =
      kneeStart * (2 * kneeProgressCubed - 3 * kneeProgressSquared + 1) +
      kneeSpan * (kneeProgressCubed - 2 * kneeProgressSquared + kneeProgress) +
      ceiling * (3 * kneeProgressSquared - 2 * kneeProgressCubed);
  }
  return sample < 0 ? -shaped : shaped;
}

/**
 * Maximizer: gets a mix louder with less squeezing than a limiter alone. Two stages:
 * 1. a look-ahead limiter (the SDK's `LookaheadLimiter`, stereo-linked, true peaks) brings the peaks to
 *    `clip` dB over the ceiling, with the same smooth ramps and release as the Limiter plugin;
 * 2. a soft clip, at 2× oversampling, rounds those last `clip` dB (and the `knee` dB under the ceiling) off.
 * The limiter alone would have to turn the whole mix down for every kick; the clip takes the top of the peaks
 * instead, as a few harmonics on the transient. How much it may take is bounded by `clip`, so it can never
 * crush a mix. Put a Limiter with the same ceiling after it: the soft clip's output filter overshoots a little, and the Limiter takes that off.
 */
export class MaximizerKernel extends EffectKernel<Params> {
  private readonly limiter = new LookaheadLimiter(lookaheadFrames(this.sampleRate));
  /** Total delay in frames (the reported latency). */
  readonly latency = this.limiter.latency;
  private readonly oversamplers = [new Oversampler(OVERSAMPLING), new Oversampler(OVERSAMPLING)];
  // Cached param conversions.
  private inputDb = Number.NaN;
  private inputGain = 1;
  private ceilingDb = Number.NaN;
  private clipDb = Number.NaN;
  private kneeDb = Number.NaN;
  private releaseMs = Number.NaN;
  /** Linear: where the first stage holds the peaks, the soft clip's output ceiling, where its knee starts, and the knee's span. */
  private holdLevel = 1;
  private ceilingGain = 1;
  private kneeStartLevel = 1;
  private kneeSpan = 0;
  private isClipOn = false;
  /** Gain reduction of the limiter stage, and the dB the soft clip took off the loudest peak, for the editor. */
  private readonly meter = new Readings(this.host, ['gr', 'clip'] as const);

  override reset(): void {
    this.limiter.reset();
    for (const o of this.oversamplers) o.reset();
    this.meter.values.gr = 0;
    this.meter.values.clip = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const limiter = this.limiter;
    const leftOversampler = this.oversamplers[0] as Oversampler;
    const rightOversampler = this.oversamplers[1] as Oversampler;
    limiter.minGain = 1;
    let peakBefore = 0;
    let peakAfter = 0;
    for (let i = 0; i < frameCount; i++) {
      this.updateCachedParams(
        at(params.input, i),
        at(params.ceiling, i),
        at(params.clip, i),
        at(params.knee, i),
        at(params.release, i),
      );
      limiter.step(
        (inLeft[i] as number) * this.inputGain,
        (inRight[i] as number) * this.inputGain,
        this.holdLevel,
        true,
      );
      const limitedLeft = limiter.outL;
      const limitedRight = limiter.outR;
      if (!this.isClipOn) {
        outLeft[i] = limitedLeft;
        outRight[i] = limitedRight;
        continue;
      }
      const kneeStartLevel = this.kneeStartLevel;
      const holdLevel = this.holdLevel;
      const ceilingGain = this.ceilingGain;
      const kneeSpan = this.kneeSpan;
      leftOversampler.up(limitedLeft);
      rightOversampler.up(limitedRight);
      const leftSamples = leftOversampler.buffer;
      const rightSamples = rightOversampler.buffer;
      for (let sampleSlot = 0; sampleSlot < OVERSAMPLING; sampleSlot++) {
        const leftBefore = leftSamples[sampleSlot] as number;
        const rightBefore = rightSamples[sampleSlot] as number;
        const leftAfter = softClipShape(leftBefore, kneeStartLevel, holdLevel, ceilingGain, kneeSpan);
        const rightAfter = softClipShape(rightBefore, kneeStartLevel, holdLevel, ceilingGain, kneeSpan);
        leftSamples[sampleSlot] = leftAfter;
        rightSamples[sampleSlot] = rightAfter;
        const pairPeakBefore = Math.max(
          leftBefore < 0 ? -leftBefore : leftBefore,
          rightBefore < 0 ? -rightBefore : rightBefore,
        );
        if (pairPeakBefore > peakBefore) peakBefore = pairPeakBefore;
        const pairPeakAfter = Math.max(
          leftAfter < 0 ? -leftAfter : leftAfter,
          rightAfter < 0 ? -rightAfter : rightAfter,
        );
        if (pairPeakAfter > peakAfter) peakAfter = pairPeakAfter;
      }
      outLeft[i] = leftOversampler.down();
      outRight[i] = rightOversampler.down();
    }
    const minGain = limiter.minGain;
    const reductionDb = minGain < 1 ? -20 * Math.log10(minGain) : 0;
    const fallDb = (20 * frameCount) / this.sampleRate;
    const shownReductionDb = this.meter.values.gr - fallDb;
    this.meter.values.gr = reductionDb > shownReductionDb ? reductionDb : shownReductionDb > 0 ? shownReductionDb : 0;
    const clippedDb = peakAfter > 0 && peakBefore > peakAfter ? 20 * Math.log10(peakBefore / peakAfter) : 0;
    const shownClippedDb = this.meter.values.clip - fallDb;
    this.meter.values.clip = clippedDb > shownClippedDb ? clippedDb : shownClippedDb > 0 ? shownClippedDb : 0;
    this.meter.tick(frameCount);
  }

  private updateCachedParams(
    inputDb: number,
    ceilingDb: number,
    clipDb: number,
    kneeDb: number,
    releaseMs: number,
  ): void {
    if (inputDb !== this.inputDb) {
      this.inputDb = inputDb;
      this.inputGain = dbToGain(inputDb);
    }
    if (ceilingDb !== this.ceilingDb || clipDb !== this.clipDb || kneeDb !== this.kneeDb) {
      if (clipDb >= CLIP_OFF_DB && !this.isClipOn) for (const o of this.oversamplers) o.reset();
      this.ceilingDb = ceilingDb;
      this.clipDb = clipDb;
      this.kneeDb = kneeDb;
      const ceilingGain = dbToGain(ceilingDb);
      const clipDepthDb = Math.min(MAX_CLIP_DB, Math.max(0, clipDb));
      this.isClipOn = clipDepthDb >= CLIP_OFF_DB;
      this.ceilingGain = ceilingGain;
      this.holdLevel = this.isClipOn ? ceilingGain * dbToGain(clipDepthDb) : ceilingGain;
      // The knee starts `kneeDb` under the ceiling, and far enough down that the cubic stays monotonic
      // (its end slope is 0, so the curve needs at least a third of the way's rise: knee span ≥ half the clip's).
      const kneeStartGain = ceilingGain * dbToGain(-Math.max(0.1, kneeDb));
      this.kneeStartLevel = Math.min(kneeStartGain, ceilingGain - (this.holdLevel - ceilingGain) / 2);
      this.kneeSpan = this.holdLevel - this.kneeStartLevel;
    }
    if (releaseMs !== this.releaseMs) {
      this.releaseMs = releaseMs;
      this.limiter.releaseCoef = 1 - Math.exp(-1000 / (Math.max(0.1, releaseMs) * this.sampleRate));
    }
  }
}
