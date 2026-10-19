import { at, dbToGain, EffectKernel, EnvelopeFollower, Readings, type ParamBlock } from '@agstudio/sdk/worklet';
import type { multibandParams } from './params';

type Params = typeof multibandParams;

/** Soft knee of every band, dB. */
const KNEE_DB = 6;
/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;
/** ln(10) / 20: gain = exp(NEPER_PER_DB · dB). */
const NEPER_PER_DB = 0.11512925464970229;
/** Crossovers follow their params every CONTROL frames. */
const CONTROL_FRAMES = 32;
/** The band gains are worked out every STEP frames (from the peak since) and ramped in between. */
const STEP_FRAMES = 4;
/** Butterworth: two of these in series make a Linkwitz-Riley section. */
const SVF_K = Math.SQRT2;
/** Each channel has seven filter stages with two states each. */
const STATES_PER_CHANNEL = 14;

/**
 * Gain reduction in dB (≥ 0) of the static curve: hard above the threshold, a quadratic soft knee
 * `knee` dB wide around it (Giannoulis, Massberg & Reiss 2012).
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
 * One band's compressor: a stereo-linked peak detector, the static curve and smoothing in dB,
 * evaluated every STEP frames on the peak of those frames (one logarithm and one exponential per
 * step), with the linear gain ramped across the step.
 */
class BandCompressor {
  readonly reductionSmoother: EnvelopeFollower;
  private attackMs = -1;
  private releaseMs = -1;
  private thresholdDb = Number.NaN;
  /** Where the knee starts, as a linear level (below it nothing needs a logarithm). */
  private kneeStartLevel = 0;
  private peakSinceStep = 0;
  /** The gain this frame, and its change per frame until the next step. */
  gain = 1;
  private gainPerFrame = 0;
  /** Gain reduction of the last step, dB. */
  reductionDb = 0;

  constructor(sampleRate: number) {
    this.reductionSmoother = new EnvelopeFollower(sampleRate / STEP_FRAMES, 10, 150);
  }

  /** Feeds a frame's peak level; returns the band's gain for it. */
  track(level: number): number {
    if (level > this.peakSinceStep) this.peakSinceStep = level;
    if (this.gainPerFrame !== 0) this.gain += this.gainPerFrame;
    return this.gain;
  }

  /** Every STEP frames: the next gain from the peak of the last ones. */
  step(thresholdDb: number, ratio: number, attackMs: number, releaseMs: number, makeupDb: number): void {
    if (attackMs !== this.attackMs || releaseMs !== this.releaseMs) {
      this.attackMs = attackMs;
      this.releaseMs = releaseMs;
      this.reductionSmoother.setTimes(attackMs, releaseMs);
    }
    if (thresholdDb !== this.thresholdDb) {
      this.thresholdDb = thresholdDb;
      this.kneeStartLevel = dbToGain(thresholdDb - KNEE_DB / 2);
    }
    // Under the knee there is nothing to compute (no logarithm).
    const peakLevel = this.peakSinceStep;
    this.peakSinceStep = 0;
    const targetReductionDb =
      peakLevel > this.kneeStartLevel
        ? gainReduction(DB_PER_NEPER * Math.log(peakLevel), thresholdDb, ratio, KNEE_DB)
        : 0;
    const reductionDb = this.reductionSmoother.process(targetReductionDb);
    this.reductionDb = reductionDb;
    const netGainDb = makeupDb - reductionDb;
    const nextGain = netGainDb === 0 ? 1 : Math.exp(NEPER_PER_DB * netGainDb);
    this.gainPerFrame = (nextGain - this.gain) / STEP_FRAMES;
    if (this.gainPerFrame === 0) this.gain = nextGain;
  }

  reset(): void {
    this.reductionSmoother.reset();
    this.reductionDb = 0;
    this.peakSinceStep = 0;
    this.gain = 1;
    this.gainPerFrame = 0;
  }
}

/**
 * Three-band compressor. Two Linkwitz-Riley crossovers split the signal (the low band goes
 * through the upper crossover's allpass so all three line up and sum flat), each band has its own
 * compressor, makeup gain, solo and bypass, and the bands are added back together. Untouched, the
 * output is the input through an allpass: the same level at every frequency.
 *
 * The crossovers are the SDK LinkwitzRiley's math (Cytomic state-variable filters) written out on
 * flat arrays: seven filter stages per side, cheap enough to leave the CPU to the compressors.
 */
export class MultibandKernel extends EffectKernel<Params> {
  /** Coefficients (a1, a2, a3) of the low and the high crossover. */
  private readonly crossoverCoefficients = new Float64Array(6);
  /**
   * Filter states (ic1, ic2) per side: [low xo: first, low stage, high stage; high xo: first, low
   * stage, high stage, allpass] = 7 stages × 2 values, left then right.
   */
  private readonly filterStates = new Float64Array(28);
  private readonly lowCompressor = new BandCompressor(this.sampleRate);
  private readonly midCompressor = new BandCompressor(this.sampleRate);
  private readonly highCompressor = new BandCompressor(this.sampleRate);
  private readonly meter = new Readings(this.host, ['lowGr', 'midGr', 'highGr'] as const);
  private countdown = 0;
  private frameInStep = 0;
  private lowHz = -1;
  private highHz = -1;
  private outputDb = 0;
  private outputGain = 1;

  override reset(): void {
    this.filterStates.fill(0);
    this.lowCompressor.reset();
    this.midCompressor.reset();
    this.highCompressor.reset();
    this.countdown = 0;
    this.frameInStep = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const isLowSolo = (params.lowSolo[0] as number) >= 0.5;
    const isMidSolo = (params.midSolo[0] as number) >= 0.5;
    const isHighSolo = (params.highSolo[0] as number) >= 0.5;
    const isAnySolo = isLowSolo || isMidSolo || isHighSolo;
    const isLowBypassed = (params.lowBypass[0] as number) >= 0.5;
    const isMidBypassed = (params.midBypass[0] as number) >= 0.5;
    const isHighBypassed = (params.highBypass[0] as number) >= 0.5;
    const lowCompressor = this.lowCompressor;
    const midCompressor = this.midCompressor;
    const highCompressor = this.highCompressor;
    const coefficients = this.crossoverCoefficients;
    const states = this.filterStates;
    let lowReductionDb = 0;
    let midReductionDb = 0;
    let highReductionDb = 0;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.setCrossovers(at(params.lowFreq, i), at(params.highFreq, i));
        const outputDb = at(params.output, i);
        if (outputDb !== this.outputDb) {
          this.outputDb = outputDb;
          this.outputGain = dbToGain(outputDb);
        }
      }
      this.countdown--;
      if (this.frameInStep === 0) {
        if (!isLowBypassed)
          lowCompressor.step(
            at(params.lowThreshold, i),
            at(params.lowRatio, i),
            at(params.lowAttack, i),
            at(params.lowRelease, i),
            at(params.lowGain, i),
          );
        if (!isMidBypassed)
          midCompressor.step(
            at(params.midThreshold, i),
            at(params.midRatio, i),
            at(params.midAttack, i),
            at(params.midRelease, i),
            at(params.midGain, i),
          );
        if (!isHighBypassed)
          highCompressor.step(
            at(params.highThreshold, i),
            at(params.highRatio, i),
            at(params.highAttack, i),
            at(params.highRelease, i),
            at(params.highGain, i),
          );
        if (!isLowBypassed && lowCompressor.reductionDb > lowReductionDb) lowReductionDb = lowCompressor.reductionDb;
        if (!isMidBypassed && midCompressor.reductionDb > midReductionDb) midReductionDb = midCompressor.reductionDb;
        if (!isHighBypassed && highCompressor.reductionDb > highReductionDb)
          highReductionDb = highCompressor.reductionDb;
      }
      this.frameInStep = this.frameInStep + 1 < STEP_FRAMES ? this.frameInStep + 1 : 0;
      const outputGain = this.outputGain;
      // Left, then right: split, compress, sum. Each of the seven stages below is one step of a Cytomic
      // state-variable filter (Andrew Simper, "Linear Trapezoidal Integrated SVF") at Butterworth damping:
      // ic1 and ic2 are the stage's two states, v1 is its band-pass part and v2 its low-pass output; the
      // high-pass is the input minus k * v1 minus v2. They are written out one after the other (and not
      // as a function or a method per stage): measured, a call per stage costs 15 % of this effect's CPU.
      for (let channel = 0; channel < 2; channel++) {
        const stateOffset = channel * STATES_PER_CHANNEL;
        const inputSample = (channel === 0 ? inLeft : inRight)[i] as number;
        // Low crossover: the first stage's low and high outputs, then one more stage each.
        let a1 = coefficients[0] as number;
        let a2 = coefficients[1] as number;
        let a3 = coefficients[2] as number;
        let ic1 = states[stateOffset] as number;
        let ic2 = states[stateOffset + 1] as number;
        let v3 = inputSample - ic2;
        let v1 = a1 * ic1 + a2 * v3;
        let v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset] = 2 * v1 - ic1;
        states[stateOffset + 1] = 2 * v2 - ic2;
        const firstLow = v2;
        const firstHigh = inputSample - SVF_K * v1 - v2;
        ic1 = states[stateOffset + 2] as number;
        ic2 = states[stateOffset + 3] as number;
        v3 = firstLow - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset + 2] = 2 * v1 - ic1;
        states[stateOffset + 3] = 2 * v2 - ic2;
        const lowFiltered = v2;
        ic1 = states[stateOffset + 4] as number;
        ic2 = states[stateOffset + 5] as number;
        v3 = firstHigh - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset + 4] = 2 * v1 - ic1;
        states[stateOffset + 5] = 2 * v2 - ic2;
        const rest = firstHigh - SVF_K * v1 - v2;
        // High crossover on the rest, and its allpass on the low band.
        a1 = coefficients[3] as number;
        a2 = coefficients[4] as number;
        a3 = coefficients[5] as number;
        ic1 = states[stateOffset + 6] as number;
        ic2 = states[stateOffset + 7] as number;
        v3 = rest - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset + 6] = 2 * v1 - ic1;
        states[stateOffset + 7] = 2 * v2 - ic2;
        const secondLow = v2;
        const secondHigh = rest - SVF_K * v1 - v2;
        ic1 = states[stateOffset + 8] as number;
        ic2 = states[stateOffset + 9] as number;
        v3 = secondLow - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset + 8] = 2 * v1 - ic1;
        states[stateOffset + 9] = 2 * v2 - ic2;
        const midBand = v2;
        ic1 = states[stateOffset + 10] as number;
        ic2 = states[stateOffset + 11] as number;
        v3 = secondHigh - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset + 10] = 2 * v1 - ic1;
        states[stateOffset + 11] = 2 * v2 - ic2;
        const highBand = secondHigh - SVF_K * v1 - v2;
        ic1 = states[stateOffset + 12] as number;
        ic2 = states[stateOffset + 13] as number;
        v3 = lowFiltered - ic2;
        v1 = a1 * ic1 + a2 * v3;
        v2 = ic2 + a2 * ic1 + a3 * v3;
        states[stateOffset + 12] = 2 * v1 - ic1;
        states[stateOffset + 13] = 2 * v2 - ic2;
        const lowAligned = lowFiltered - 2 * SVF_K * v1;
        if (channel === 0) {
          this.bandSamples[0] = lowAligned;
          this.bandSamples[1] = midBand;
          this.bandSamples[2] = highBand;
        } else {
          this.bandSamples[3] = lowAligned;
          this.bandSamples[4] = midBand;
          this.bandSamples[5] = highBand;
        }
      }
      const bandSamples = this.bandSamples;
      let lowGain = isLowBypassed ? 1 : lowCompressor.track(louder(bandSamples[0] as number, bandSamples[3] as number));
      let midGain = isMidBypassed ? 1 : midCompressor.track(louder(bandSamples[1] as number, bandSamples[4] as number));
      let highGain = isHighBypassed
        ? 1
        : highCompressor.track(louder(bandSamples[2] as number, bandSamples[5] as number));
      if (isAnySolo) {
        if (!isLowSolo) lowGain = 0;
        if (!isMidSolo) midGain = 0;
        if (!isHighSolo) highGain = 0;
      }
      outLeft[i] =
        ((bandSamples[0] as number) * lowGain +
          (bandSamples[1] as number) * midGain +
          (bandSamples[2] as number) * highGain) *
        outputGain;
      outRight[i] =
        ((bandSamples[3] as number) * lowGain +
          (bandSamples[4] as number) * midGain +
          (bandSamples[5] as number) * highGain) *
        outputGain;
    }
    // Silence must not leave denormals in the filters.
    for (let k = 0; k < states.length; k++) if (!(Math.abs(states[k] as number) > 1e-20)) states[k] = 0;
    const readings = this.meter.values;
    readings.lowGr = lowReductionDb;
    readings.midGr = midReductionDb;
    readings.highGr = highReductionDb;
    this.meter.tick(frameCount);
  }

  /** This frame's bands: low, mid, high (left), then the same for the right. */
  private readonly bandSamples = new Float64Array(6);

  /** Crossover coefficients, recomputed when the frequencies move. */
  private setCrossovers(lowHz: number, highHz: number): void {
    // The high crossover stays at least an octave above the low one.
    const clampedHighHz = Math.max(highHz, 2 * lowHz);
    if (lowHz === this.lowHz && clampedHighHz === this.highHz) return;
    this.lowHz = lowHz;
    this.highHz = clampedHighHz;
    designCrossover(this.crossoverCoefficients, 0, lowHz, this.sampleRate);
    designCrossover(this.crossoverCoefficients, 3, clampedHighHz, this.sampleRate);
  }
}

/** Cytomic SVF coefficients (a1, a2, a3) at Butterworth Q for `freq`, into `out` at `o`. */
function designCrossover(out: Float64Array, offset: number, frequencyHz: number, sampleRate: number): void {
  const warp = Math.tan((Math.PI * Math.min(Math.max(frequencyHz, 1), sampleRate * 0.49)) / sampleRate);
  const a1 = 1 / (1 + warp * (warp + SVF_K));
  out[offset] = a1;
  out[offset + 1] = warp * a1;
  out[offset + 2] = warp * warp * a1;
}

function louder(a: number, b: number): number {
  const x = a < 0 ? -a : a;
  const y = b < 0 ? -b : b;
  return x > y ? x : y;
}
