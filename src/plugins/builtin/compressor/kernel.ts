import { at, dbToGain, EffectKernel, EnvelopeFollower, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import type { compressorParams } from './params';

type Params = typeof compressorParams;

/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;
/** Below this the key counts as silence (−120 dBFS). */
const KEY_SILENCE_LEVEL = 1e-6;
/** The SC filter's lowest setting means "off". */
export const SC_FILTER_OFF = 20;

/**
 * Gain reduction in dB (≥ 0) of the static curve for a level in dB: hard knee above the threshold,
 * a quadratic soft knee `knee` dB wide around it (Giannoulis, Massberg & Reiss 2012).
 */
export function gainReduction(levelDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
  const overDb = levelDb - thresholdDb;
  const slope = 1 - 1 / Math.max(1, ratio);
  if (kneeDb > 0 && 2 * Math.abs(overDb) <= kneeDb) {
    const intoKneeDb = overDb + kneeDb / 2;
    return (slope * intoKneeDb * intoKneeDb) / (2 * kneeDb);
  }
  return overDb > 0 ? slope * overDb : 0;
}

/**
 * Feed-forward compressor with zero latency (no look-ahead, so it adds no delay to the mix). The key
 * (the sidechain input: the chosen track, or the effect's own input when none is chosen) goes
 * through a 12 dB/octave high-pass (off at its 20 Hz minimum), a stereo-linked peak detector and
 * the static curve; the gain
 * reduction is smoothed in dB with attack/release time constants (smooth branching, so the release
 * sets how fast the level recovers whatever the attack). Listen outputs the filtered key.
 */
export class CompressorKernel extends EffectKernel<Params> {
  private readonly keyHighpassLeft = new Svf();
  private readonly keyHighpassRight = new Svf();
  private readonly reductionSmoother = new EnvelopeFollower(this.sampleRate, 5, 150);
  private cutoffHz = -1;
  private attackMs = -1;
  private releaseMs = -1;

  override reset(): void {
    this.keyHighpassLeft.reset();
    this.keyHighpassRight.reset();
    this.reductionSmoother.reset();
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    frameCount: number,
    params: ParamBlock<Params>,
    sidechain?: Float32Array[],
  ): void {
    const key = sidechain ?? input;
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const keyLeft = key[0] as Float32Array;
    const keyRight = (key[1] ?? keyLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const isListening = (params.listen[0] as number) >= 0.5;
    for (let i = 0; i < frameCount; i++) {
      const cutoffHz = at(params.scFilter, i);
      this.coefficients(cutoffHz, at(params.attack, i), at(params.release, i));
      // The filters always run (switching the filter on doesn't start from a cold state).
      const highpassedLeft = this.keyHighpassLeft.process(keyLeft[i] as number);
      const highpassedRight = this.keyHighpassRight.process(keyRight[i] as number);
      const isFilterOff = cutoffHz <= SC_FILTER_OFF;
      const filteredLeft = isFilterOff ? (keyLeft[i] as number) : highpassedLeft;
      const filteredRight = isFilterOff ? (keyRight[i] as number) : highpassedRight;
      if (isListening) {
        outLeft[i] = filteredLeft;
        outRight[i] = filteredRight;
        continue;
      }
      const leftLevel = filteredLeft < 0 ? -filteredLeft : filteredLeft;
      const rightLevel = filteredRight < 0 ? -filteredRight : filteredRight;
      const level = leftLevel > rightLevel ? leftLevel : rightLevel;
      const levelDb = level > KEY_SILENCE_LEVEL ? DB_PER_NEPER * Math.log(level) : -120;
      const reductionDb = this.reductionSmoother.process(
        gainReduction(levelDb, at(params.threshold, i), at(params.ratio, i), at(params.knee, i)),
      );
      const netGainDb = at(params.makeup, i) - reductionDb;
      const gain = netGainDb === 0 ? 1 : dbToGain(netGainDb);
      outLeft[i] = (inLeft[i] as number) * gain;
      outRight[i] = (inRight[i] as number) * gain;
    }
  }

  /** Recomputes filter and ballistics coefficients only when their params change. */
  private coefficients(cutoffHz: number, attackMs: number, releaseMs: number): void {
    if (cutoffHz !== this.cutoffHz) {
      this.cutoffHz = cutoffHz;
      this.keyHighpassLeft.set('highpass', cutoffHz, Math.SQRT1_2, this.sampleRate);
      this.keyHighpassRight.set('highpass', cutoffHz, Math.SQRT1_2, this.sampleRate);
    }
    if (attackMs !== this.attackMs || releaseMs !== this.releaseMs) {
      this.attackMs = attackMs;
      this.releaseMs = releaseMs;
      this.reductionSmoother.setTimes(attackMs, releaseMs);
    }
  }
}
