import { at, dbToGain, EffectKernel, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import { BAND_COUNTS, type vocoderParams } from './params';

type Params = typeof vocoderParams;

const MAX_BANDS = 32;
/** Centre of the lowest and highest band. */
const LOWEST_BAND_HZ = 90;
const HIGHEST_BAND_HZ = 9000;
/** The modulator's highs above this pass straight through (sibilance). */
const SIBILANCE_HZ = 6000;
/** Noise added to the carrier at 100 %. */
const NOISE_LEVEL = 0.15;
/** Brings the band products back to about the level of the input. */
const BAND_MAKEUP = 60;
/** Designs follow their params every CONTROL frames. */
const CONTROL_FRAMES = 32;
const BAND_COUNT_VALUES = BAND_COUNTS.map(Number);

/**
 * Channel vocoder. The modulator (a voice: the sidechain, mono) and the carrier (a synth: the
 * input, stereo) go through the same bank of 16–32 log-spaced band-passes (two state-variable
 * stages each, so neighbours overlap at −3 dB); an envelope follower on each modulator band sets
 * the level of the matching carrier band, and the bands are summed. Formant shifts the carrier
 * bands against the modulator's, Sibilance adds the voice's own highs, Noise helps whispers through.
 *
 * The bands are independent, so each control chunk (CONTROL frames, over which the designs and the
 * ballistics stay fixed) runs band by band: a band's coefficients and filter states stay in local
 * variables for the whole chunk, and the summed outputs are accumulated per frame. The arithmetic
 * is that of a frame-by-frame pass, operation for operation.
 */
export class VocoderKernel extends EffectKernel<Params> {
  // Per band: modulator and carrier coefficients (a1, a2, 2g, k of a Cytomic SVF band-pass).
  private readonly modulatorCoefficients = new Float64Array(4 * MAX_BANDS);
  private readonly carrierCoefficients = new Float64Array(4 * MAX_BANDS);
  // Per band: two stages × (ic1, ic2) for the modulator and each carrier side.
  private readonly modulatorState = new Float64Array(4 * MAX_BANDS);
  private readonly carrierLeftState = new Float64Array(4 * MAX_BANDS);
  private readonly carrierRightState = new Float64Array(4 * MAX_BANDS);
  private readonly bandEnvelope = new Float64Array(MAX_BANDS);
  // The designs' cached parts: each band's centre frequency, and tan(πf/sr) of the modulator and carrier bands.
  private readonly bandHz = new Float64Array(MAX_BANDS);
  private readonly modulatorTan = new Float64Array(MAX_BANDS);
  private readonly carrierTan = new Float64Array(MAX_BANDS);
  private bandSpacingOctaves = 0;
  private readonly sibilanceHighpass = new Svf().set('highpass', SIBILANCE_HZ, Math.SQRT1_2, this.sampleRate);
  // Per frame of the current control chunk: the modulator, the two carriers, the sibilance, and the
  // summed band outputs.
  private readonly modulatorBuffer = new Float64Array(CONTROL_FRAMES);
  private readonly carrierLeftBuffer = new Float64Array(CONTROL_FRAMES);
  private readonly carrierRightBuffer = new Float64Array(CONTROL_FRAMES);
  private readonly sibilanceBuffer = new Float64Array(CONTROL_FRAMES);
  private readonly leftSum = new Float64Array(CONTROL_FRAMES);
  private readonly rightSum = new Float64Array(CONTROL_FRAMES);
  private bandCount = 0;
  private bandWidth = -1;
  private formantSemitones = Number.NaN;
  private attackMs = -1;
  private releaseMs = -1;
  private attackCoefficient = 1;
  private releaseCoefficient = 1;
  private countdown = 0;
  private outputDb = 0;
  private outputGain = 1;

  override reset(): void {
    this.modulatorState.fill(0);
    this.carrierLeftState.fill(0);
    this.carrierRightState.fill(0);
    this.bandEnvelope.fill(0);
    this.sibilanceHighpass.reset();
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    frameCount: number,
    params: ParamBlock<Params>,
    sidechain?: Float32Array[],
  ): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const key = sidechain ?? input;
    const keyLeft = key[0] as Float32Array;
    const keyRight = (key[1] ?? keyLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const bandCount = BAND_COUNT_VALUES[Math.round(params.bands[0] as number)] ?? 24;
    // Fewer bands sum quieter: keep the level about the same whatever the count.
    const makeupGain = BAND_MAKEUP * Math.sqrt(24 / bandCount);
    const modulatorBuffer = this.modulatorBuffer;
    const carrierLeftBuffer = this.carrierLeftBuffer;
    const carrierRightBuffer = this.carrierRightBuffer;
    const sibilanceBuffer = this.sibilanceBuffer;
    const leftSum = this.leftSum;
    const rightSum = this.rightSum;
    for (let chunkStart = 0; chunkStart < frameCount;) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.design(bandCount, at(params.width, chunkStart), at(params.formant, chunkStart));
        this.ballistics(at(params.attack, chunkStart), at(params.release, chunkStart));
        const outputDb = at(params.output, chunkStart);
        if (outputDb !== this.outputDb) {
          this.outputDb = outputDb;
          this.outputGain = dbToGain(outputDb);
        }
      }
      // The designs hold for the rest of the chunk (the countdown), so the chunk is that many frames.
      const chunkLength = Math.min(this.countdown, frameCount - chunkStart);
      this.countdown -= chunkLength;
      for (let j = 0; j < chunkLength; j++) {
        const i = chunkStart + j;
        const modulatorSample = 0.5 * ((keyLeft[i] as number) + (keyRight[i] as number));
        const noise = at(params.noise, i) * NOISE_LEVEL * (2 * this.host.rand() - 1);
        const inputLeft = inLeft[i] as number;
        const inputRight = inRight[i] as number;
        modulatorBuffer[j] = modulatorSample;
        carrierLeftBuffer[j] = inputLeft + noise;
        carrierRightBuffer[j] = inputRight + noise;
        sibilanceBuffer[j] = at(params.sibilance, i) * this.sibilanceHighpass.process(modulatorSample);
        leftSum[j] = 0;
        rightSum[j] = 0;
      }
      const attackCoefficient = this.attackCoefficient;
      const releaseCoefficient = this.releaseCoefficient;
      for (let bandIndex = 0; bandIndex < bandCount; bandIndex++)
        this.band(bandIndex, chunkLength, attackCoefficient, releaseCoefficient);
      const outputGain = this.outputGain;
      for (let j = 0; j < chunkLength; j++) {
        const i = chunkStart + j;
        const xl = inLeft[i] as number;
        const xr = inRight[i] as number;
        const mix = at(params.mix, i);
        const sibilanceSample = sibilanceBuffer[j] as number;
        outLeft[i] = outputGain * (xl + mix * ((leftSum[j] as number) * makeupGain + sibilanceSample - xl));
        outRight[i] = outputGain * (xr + mix * ((rightSum[j] as number) * makeupGain + sibilanceSample - xr));
      }
      chunkStart += chunkLength;
    }
    this.flushStates(bandCount);
  }

  /**
   * One band over the frames of the current chunk: its modulator envelope, and its contribution to
   * the left and right carrier sums (`accL`, `accR`, per frame).
   */
  private band(bandIndex: number, chunkLength: number, attackCoefficient: number, releaseCoefficient: number): void {
    const coefficientOffset = 4 * bandIndex;
    const modulatorCoefficients = this.modulatorCoefficients;
    const carrierCoefficients = this.carrierCoefficients;
    const modulatorBuffer = this.modulatorBuffer;
    const carrierLeftBuffer = this.carrierLeftBuffer;
    const carrierRightBuffer = this.carrierRightBuffer;
    const leftSum = this.leftSum;
    const rightSum = this.rightSum;
    const modulatorA1 = modulatorCoefficients[coefficientOffset] as number;
    const modulatorA2 = modulatorCoefficients[coefficientOffset + 1] as number;
    const modulator2g = modulatorCoefficients[coefficientOffset + 2] as number;
    const modulatorK = modulatorCoefficients[coefficientOffset + 3] as number;
    const carrierA1 = carrierCoefficients[coefficientOffset] as number;
    const carrierA2 = carrierCoefficients[coefficientOffset + 1] as number;
    const carrier2g = carrierCoefficients[coefficientOffset + 2] as number;
    const carrierK = carrierCoefficients[coefficientOffset + 3] as number;
    // Stage 1 (ic1, ic2) and stage 2 (ic1, ic2) of each bank.
    const modulatorStates = this.modulatorState;
    const leftStates = this.carrierLeftState;
    const rightStates = this.carrierRightState;
    let modulatorStage1Ic1 = modulatorStates[coefficientOffset] as number;
    let modulatorStage1Ic2 = modulatorStates[coefficientOffset + 1] as number;
    let modulatorStage2Ic1 = modulatorStates[coefficientOffset + 2] as number;
    let modulatorStage2Ic2 = modulatorStates[coefficientOffset + 3] as number;
    let leftStage1Ic1 = leftStates[coefficientOffset] as number;
    let leftStage1Ic2 = leftStates[coefficientOffset + 1] as number;
    let leftStage2Ic1 = leftStates[coefficientOffset + 2] as number;
    let leftStage2Ic2 = leftStates[coefficientOffset + 3] as number;
    let rightStage1Ic1 = rightStates[coefficientOffset] as number;
    let rightStage1Ic2 = rightStates[coefficientOffset + 1] as number;
    let rightStage2Ic1 = rightStates[coefficientOffset + 2] as number;
    let rightStage2Ic2 = rightStates[coefficientOffset + 3] as number;
    let envelope = this.bandEnvelope[bandIndex] as number;
    // Each stage (trapezoidal SVF, g = tan(πf/sr)): v3 = x − ic2, v1 = a1·ic1 + a2·v3, output k·v1,
    // then ic1 = 2·v1 − ic1 and ic2 = ic2 + 2g·v1 (the same as 2·(ic2 + g·v1) − ic2).
    for (let j = 0; j < chunkLength; j++) {
      // Modulator band: two SVF band-pass stages.
      let v3 = (modulatorBuffer[j] as number) - modulatorStage1Ic2;
      let v1 = modulatorA1 * modulatorStage1Ic1 + modulatorA2 * v3;
      const modulatorStage1Ic1Next = 2 * v1 - modulatorStage1Ic1;
      modulatorStage1Ic2 += modulator2g * v1;
      modulatorStage1Ic1 = modulatorStage1Ic1Next;
      let stageOutput = modulatorK * v1;
      v3 = stageOutput - modulatorStage2Ic2;
      v1 = modulatorA1 * modulatorStage2Ic1 + modulatorA2 * v3;
      const modulatorStage2Ic1Next = 2 * v1 - modulatorStage2Ic1;
      modulatorStage2Ic2 += modulator2g * v1;
      modulatorStage2Ic1 = modulatorStage2Ic1Next;
      stageOutput = modulatorK * v1;
      // Its envelope.
      const modulatorLevel = stageOutput < 0 ? -stageOutput : stageOutput;
      const newEnvelope =
        envelope + (modulatorLevel > envelope ? attackCoefficient : releaseCoefficient) * (modulatorLevel - envelope);
      envelope = newEnvelope;
      // Carrier band, left.
      v3 = (carrierLeftBuffer[j] as number) - leftStage1Ic2;
      v1 = carrierA1 * leftStage1Ic1 + carrierA2 * v3;
      const leftStage1Ic1Next = 2 * v1 - leftStage1Ic1;
      leftStage1Ic2 += carrier2g * v1;
      leftStage1Ic1 = leftStage1Ic1Next;
      stageOutput = carrierK * v1;
      v3 = stageOutput - leftStage2Ic2;
      v1 = carrierA1 * leftStage2Ic1 + carrierA2 * v3;
      const leftStage2Ic1Next = 2 * v1 - leftStage2Ic1;
      leftStage2Ic2 += carrier2g * v1;
      leftStage2Ic1 = leftStage2Ic1Next;
      leftSum[j] = (leftSum[j] as number) + carrierK * v1 * newEnvelope;
      // Carrier band, right.
      v3 = (carrierRightBuffer[j] as number) - rightStage1Ic2;
      v1 = carrierA1 * rightStage1Ic1 + carrierA2 * v3;
      const rightStage1Ic1Next = 2 * v1 - rightStage1Ic1;
      rightStage1Ic2 += carrier2g * v1;
      rightStage1Ic1 = rightStage1Ic1Next;
      stageOutput = carrierK * v1;
      v3 = stageOutput - rightStage2Ic2;
      v1 = carrierA1 * rightStage2Ic1 + carrierA2 * v3;
      const rightStage2Ic1Next = 2 * v1 - rightStage2Ic1;
      rightStage2Ic2 += carrier2g * v1;
      rightStage2Ic1 = rightStage2Ic1Next;
      rightSum[j] = (rightSum[j] as number) + carrierK * v1 * newEnvelope;
    }
    modulatorStates[coefficientOffset] = modulatorStage1Ic1;
    modulatorStates[coefficientOffset + 1] = modulatorStage1Ic2;
    modulatorStates[coefficientOffset + 2] = modulatorStage2Ic1;
    modulatorStates[coefficientOffset + 3] = modulatorStage2Ic2;
    leftStates[coefficientOffset] = leftStage1Ic1;
    leftStates[coefficientOffset + 1] = leftStage1Ic2;
    leftStates[coefficientOffset + 2] = leftStage2Ic1;
    leftStates[coefficientOffset + 3] = leftStage2Ic2;
    rightStates[coefficientOffset] = rightStage1Ic1;
    rightStates[coefficientOffset + 1] = rightStage1Ic2;
    rightStates[coefficientOffset + 2] = rightStage2Ic1;
    rightStates[coefficientOffset + 3] = rightStage2Ic2;
    this.bandEnvelope[bandIndex] = envelope;
  }

  /**
   * Band frequencies and widths for both banks (only when they change). A band's frequency depends
   * on the band count, its carrier frequency also on the formant, and the filter's g only on the
   * frequency: those are kept, so a width change only redoes the Q-dependent part.
   */
  private design(bandCount: number, bandWidth: number, formantSemitones: number): void {
    if (bandCount === this.bandCount && bandWidth === this.bandWidth && formantSemitones === this.formantSemitones)
      return;
    const sampleRate = this.sampleRate;
    const hasNewBandCount = bandCount !== this.bandCount;
    if (hasNewBandCount) {
      this.reset();
      this.bandCount = bandCount;
      this.bandSpacingOctaves = Math.log2(HIGHEST_BAND_HZ / LOWEST_BAND_HZ) / (bandCount - 1);
      for (let b = 0; b < bandCount; b++) {
        const centreHz = LOWEST_BAND_HZ * Math.pow(2, b * this.bandSpacingOctaves);
        this.modulatorTan[b] = Math.tan((Math.PI * Math.min(centreHz, 0.45 * sampleRate)) / sampleRate);
        this.bandHz[b] = centreHz;
      }
    }
    if (hasNewBandCount || formantSemitones !== this.formantSemitones) {
      this.formantSemitones = formantSemitones;
      const formantRatio = Math.pow(2, formantSemitones / 12);
      for (let b = 0; b < bandCount; b++) {
        const centreHz = (this.bandHz[b] as number) * formantRatio;
        this.carrierTan[b] = Math.tan((Math.PI * Math.min(centreHz, 0.45 * sampleRate)) / sampleRate);
      }
    }
    this.bandWidth = bandWidth;
    // Two stages that meet their neighbours at −3 dB: each stage is 0.64 × the touching Q.
    const touchingQ = 1 / (Math.pow(2, this.bandSpacingOctaves / 2) - Math.pow(2, -this.bandSpacingOctaves / 2));
    const stageQ = (0.6436 * touchingQ) / bandWidth;
    for (let b = 0; b < bandCount; b++) {
      bandpassCoefficients(this.modulatorCoefficients, 4 * b, this.modulatorTan[b] as number, stageQ);
      bandpassCoefficients(this.carrierCoefficients, 4 * b, this.carrierTan[b] as number, stageQ);
    }
  }

  private ballistics(attackMs: number, releaseMs: number): void {
    if (attackMs === this.attackMs && releaseMs === this.releaseMs) return;
    this.attackMs = attackMs;
    this.releaseMs = releaseMs;
    this.attackCoefficient = 1 - Math.exp(-1000 / (attackMs * this.sampleRate));
    this.releaseCoefficient = 1 - Math.exp(-1000 / (releaseMs * this.sampleRate));
  }

  /** Silence must not leave denormals in the filters. */
  private flushStates(bandCount: number): void {
    for (let i = 0; i < 4 * bandCount; i++) {
      if (!(Math.abs(this.modulatorState[i] as number) > 1e-20)) this.modulatorState[i] = 0;
      if (!(Math.abs(this.carrierLeftState[i] as number) > 1e-20)) this.carrierLeftState[i] = 0;
      if (!(Math.abs(this.carrierRightState[i] as number) > 1e-20)) this.carrierRightState[i] = 0;
    }
    for (let b = 0; b < bandCount; b++) if (!((this.bandEnvelope[b] as number) > 1e-20)) this.bandEnvelope[b] = 0;
  }
}

/**
 * Cytomic SVF band-pass coefficients (unity gain at the centre) into `out` at `o`, from g = tan(πf/sr)
 * and the Q: a1, a2 = g·a1, 2g, and k (the damping, 1/Q).
 */
function bandpassCoefficients(out: Float64Array, offset: number, tangent: number, qFactor: number): void {
  const damping = 1 / qFactor;
  const a1 = 1 / (1 + tangent * (tangent + damping));
  out[offset] = a1;
  out[offset + 1] = tangent * a1;
  out[offset + 2] = 2 * tangent;
  out[offset + 3] = damping;
}
