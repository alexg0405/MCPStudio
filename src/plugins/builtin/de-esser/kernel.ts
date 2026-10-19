import { at, dbToGain, EffectKernel, EnvelopeFollower, Readings, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import type { deEsserParams } from './params';

type Params = typeof deEsserParams;

/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;
/** ln(10) / 20: gain = exp(NEPER_PER_DB · dB). */
const NEPER_PER_DB = 0.11512925464970229;
/** Soft knee around the threshold, dB. */
const KNEE_DB = 4;
/** The band filters follow their params every CONTROL frames. */
const CONTROL_FRAMES = 16;
/** Gain reduction below this (dB) is treated as none. */
const SILENT_REDUCTION_DB = 1e-4;

/**
 * Gain reduction in dB (≥ 0) for a band level in dB: nothing under the threshold, `1 − 1/ratio` of
 * the excess over it above (a quadratic soft knee `KNEE` dB wide around it), never more than `range`.
 */
export function deEssReduction(levelDb: number, thresholdDb: number, ratio: number, maxReductionDb: number): number {
  const overDb = levelDb - thresholdDb;
  const slope = 1 - 1 / Math.max(1, ratio);
  let reductionDb = 0;
  if (2 * Math.abs(overDb) <= KNEE_DB) {
    const intoKneeDb = overDb + KNEE_DB / 2;
    reductionDb = (slope * intoKneeDb * intoKneeDb) / (2 * KNEE_DB);
  } else if (overDb > 0) reductionDb = slope * overDb;
  return reductionDb > maxReductionDb ? maxReductionDb : reductionDb;
}

/**
 * Split-band de-esser with zero latency. A band-pass at the sibilance frequency (two 12 dB/octave
 * stages, so 1 kHz vowels barely reach the detector) is watched by a stereo-linked peak detector; the
 * static curve turns the level into gain reduction in dB, smoothed with attack and release.
 *
 * Split mode subtracts the *first stage's band* from the voice: `out = x − (1 − g) · band(x)`, which
 * is a bell filter cutting `1 − g` of the band (an analog peaking cut, so its response falls smoothly
 * to nothing away from the centre). With no reduction that is exactly the input (nothing in the signal
 * path colours the voice), and when it works only the band moves, by `g` at its centre. Wideband mode
 * multiplies the whole voice by `g`. Listen outputs the detector's band.
 */
export class DeEsserKernel extends EffectKernel<Params> {
  private readonly leftBandStage1 = new Svf();
  private readonly leftBandStage2 = new Svf();
  private readonly rightBandStage1 = new Svf();
  private readonly rightBandStage2 = new Svf();
  /** Peak level of the band (instant attack, a short release so a cycle's zero crossings don't dip it). */
  private readonly bandLevelFollower = new EnvelopeFollower(this.sampleRate, 0, 1.5);
  /** The gain reduction (dB) with the Attack and Release knobs' ballistics. */
  private readonly reductionSmoother = new EnvelopeFollower(this.sampleRate, 1, 40);
  private readonly meter = new Readings(this.host, ['gr'] as const);
  private frequencyHz = -1;
  private q = -1;
  private attackMs = -1;
  private releaseMs = -1;
  private thresholdDb = Number.NaN;
  /** Where the knee starts as a linear level: under it the detector needs no logarithm. */
  private kneeStartLevel = 0;
  private countdown = 0;

  override reset(): void {
    this.leftBandStage1.reset();
    this.leftBandStage2.reset();
    this.rightBandStage1.reset();
    this.rightBandStage2.reset();
    this.bandLevelFollower.reset();
    this.reductionSmoother.reset();
    this.meter.values.gr = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const isWideband = (params.mode[0] as number) >= 0.5;
    const isListening = (params.listen[0] as number) >= 0.5;
    let peakReductionDb = 0;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.design(at(params.frequency, i), at(params.q, i), at(params.attack, i), at(params.release, i));
      }
      this.countdown--;
      const inputLeft = inLeft[i] as number;
      const inputRight = inRight[i] as number;
      // One band-pass stage is the band that gets turned down; a second stage sharpens what the detector hears.
      const stage1Left = this.leftBandStage1.process(inputLeft);
      const stage1Right = this.rightBandStage1.process(inputRight);
      const bandLeft = this.leftBandStage2.process(stage1Left);
      const bandRight = this.rightBandStage2.process(stage1Right);
      if (isListening) {
        outLeft[i] = bandLeft;
        outRight[i] = bandRight;
        continue;
      }
      const leftLevel = bandLeft < 0 ? -bandLeft : bandLeft;
      const rightLevel = bandRight < 0 ? -bandRight : bandRight;
      const bandPeak = this.bandLevelFollower.process(leftLevel > rightLevel ? leftLevel : rightLevel);
      const thresholdDb = at(params.threshold, i);
      if (thresholdDb !== this.thresholdDb) {
        this.thresholdDb = thresholdDb;
        this.kneeStartLevel = dbToGain(thresholdDb - KNEE_DB / 2);
      }
      const targetReductionDb =
        bandPeak > this.kneeStartLevel
          ? deEssReduction(DB_PER_NEPER * Math.log(bandPeak), thresholdDb, at(params.ratio, i), at(params.range, i))
          : 0;
      const reductionDb = this.reductionSmoother.process(targetReductionDb);
      if (reductionDb > peakReductionDb) peakReductionDb = reductionDb;
      if (reductionDb < SILENT_REDUCTION_DB) {
        outLeft[i] = inputLeft;
        outRight[i] = inputRight;
        continue;
      }
      const gain = Math.exp(-NEPER_PER_DB * reductionDb);
      if (isWideband) {
        outLeft[i] = inputLeft * gain;
        outRight[i] = inputRight * gain;
      } else {
        const removedShare = 1 - gain;
        outLeft[i] = inputLeft - removedShare * stage1Left;
        outRight[i] = inputRight - removedShare * stage1Right;
      }
    }
    // The meter holds the biggest reduction of the block and falls 20 dB/s, so brief "s" sounds stay visible.
    const shownReductionDb = this.meter.values.gr - (20 * frameCount) / this.sampleRate;
    this.meter.values.gr = isListening
      ? 0
      : peakReductionDb > shownReductionDb
        ? peakReductionDb
        : shownReductionDb > 0
          ? shownReductionDb
          : 0;
    this.meter.tick(frameCount);
  }

  /** Recomputes the filters and the ballistics only when their params changed. */
  private design(frequencyHz: number, q: number, attackMs: number, releaseMs: number): void {
    if (frequencyHz !== this.frequencyHz || q !== this.q) {
      this.frequencyHz = frequencyHz;
      this.q = q;
      this.leftBandStage1.set('bandpass', frequencyHz, q, this.sampleRate);
      this.leftBandStage2.copyDesign(this.leftBandStage1);
      this.rightBandStage1.copyDesign(this.leftBandStage1);
      this.rightBandStage2.copyDesign(this.leftBandStage1);
    }
    if (attackMs !== this.attackMs || releaseMs !== this.releaseMs) {
      this.attackMs = attackMs;
      this.releaseMs = releaseMs;
      this.reductionSmoother.setTimes(attackMs, releaseMs);
    }
  }
}
