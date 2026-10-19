import { at, dbToGain, EffectKernel, OnePole, Oversampler, Ramp, type ParamBlock } from '@agstudio/sdk/worklet';
import type { saturatorParams } from './params';

type Params = typeof saturatorParams;

const MODE_TAPE = 0;
const MODE_TUBE = 1;
/** Tube bias: the curve is shifted so its two halves clip differently (even harmonics). */
const TUBE_BIAS = 0.35;
/** The curve's value at the bias point (from softClip itself, so silence stays exactly silent). */
const TUBE_BIAS_OFFSET = softClip(TUBE_BIAS);
/** Keeps the tube curve's small-signal gain at 1. */
const TUBE_NORM = 1 / (1 - TUBE_BIAS_OFFSET * TUBE_BIAS_OFFSET);
/** Drive is partly compensated: quiet sounds get a little louder, loud ones level off. */
const DRIVE_COMPENSATION_EXPONENT = -0.7;
const TILT_HZ = 800;
const TILT_DB = 6;
const DC_BLOCK_HZ = 8;
/** Drive, tone and output gains are recomputed every CONTROL frames and ramp between (see GateKernel). */
const CONTROL_FRAMES = 32;

/** tanh(x) by Lambert's continued fraction (within 1e-4 of it), exactly ±1 beyond ±4.97. */
export function softClip(x: number): number {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const squared = x * x;
  return (
    (x * (135135 + squared * (17325 + squared * (378 + squared)))) /
    (135135 + squared * (62370 + squared * (3150 + 28 * squared)))
  );
}

/** The saturation curve of a mode for a driven sample. */
export function saturate(mode: number, driven: number): number {
  if (mode === MODE_TAPE) return softClip(driven);
  if (mode === MODE_TUBE) return (softClip(driven + TUBE_BIAS) - TUBE_BIAS_OFFSET) * TUBE_NORM;
  return driven > 1 ? 1 : driven < -1 ? -1 : driven;
}

/**
 * Saturator: drive into a tape (tanh), tube (biased tanh: asymmetric, even harmonics, DC removed
 * afterwards) or hard-clip curve, at 2× or 4× the sample rate (SDK Oversampler: IIR halfbands, no
 * latency). The dry/wet mix happens in the oversampled domain, so dry and wet share the same
 * filters and stay in phase. Then a tilt EQ (±6 dB around 800 Hz) and the output level.
 */
export class SaturatorKernel extends EffectKernel<Params> {
  private readonly oversamplers2x = [new Oversampler(2), new Oversampler(2)];
  private readonly oversamplers4x = [new Oversampler(4), new Oversampler(4)];
  private readonly tiltFilters = [
    new OnePole().setCutoff(TILT_HZ, this.sampleRate),
    new OnePole().setCutoff(TILT_HZ, this.sampleRate),
  ];
  private readonly dcBlockers = [
    new OnePole().setCutoff(DC_BLOCK_HZ, this.sampleRate),
    new OnePole().setCutoff(DC_BLOCK_HZ, this.sampleRate),
  ];
  /** The param values last read: a gain is only re-aimed when its param has changed. */
  private lastDriveDb = Number.NaN;
  private lastTone = Number.NaN;
  private lastOutputDb = Number.NaN;
  private readonly driveGainRamp = new Ramp();
  private readonly compensationRamp = new Ramp();
  private readonly lowRamp = new Ramp();
  private readonly highRamp = new Ramp();
  private readonly outputGainRamp = new Ramp();
  private oversampleFactor = 0;

  override reset(): void {
    for (const o of this.oversamplers2x) o.reset();
    for (const o of this.oversamplers4x) o.reset();
    for (const f of this.tiltFilters) f.reset();
    for (const f of this.dcBlockers) f.reset();
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const mode = Math.round(params.mode[0] as number);
    const oversampleFactor = Math.round(params.oversample[0] as number) === 1 ? 4 : 2;
    if (oversampleFactor !== this.oversampleFactor) {
      // The other oversampler starts from silence rather than from where it was left.
      if (this.oversampleFactor !== 0)
        for (const o of oversampleFactor === 4 ? this.oversamplers4x : this.oversamplers2x) o.reset();
      this.oversampleFactor = oversampleFactor;
    }
    for (let blockStart = 0; blockStart < frameCount; blockStart += CONTROL_FRAMES) {
      const blockEnd = Math.min(frameCount, blockStart + CONTROL_FRAMES);
      this.aim(params, blockStart, blockEnd - blockStart);
      let driveGain = this.driveGainRamp.value;
      let compensation = this.compensationRamp.value;
      let lowGain = this.lowRamp.value;
      let highGain = this.highRamp.value;
      let outputGain = this.outputGainRamp.value;
      const driveGainSlope = this.driveGainRamp.slope;
      const compensationSlope = this.compensationRamp.slope;
      const lowGainSlope = this.lowRamp.slope;
      const highGainSlope = this.highRamp.slope;
      const outputGainSlope = this.outputGainRamp.slope;
      for (let i = blockStart; i < blockEnd; i++) {
        driveGain += driveGainSlope;
        compensation += compensationSlope;
        lowGain += lowGainSlope;
        highGain += highGainSlope;
        outputGain += outputGainSlope;
        const mix = at(params.mix, i);
        for (let channel = 0; channel < 2; channel++) {
          const inputSample = ((input[channel] ?? input[0]) as Float32Array)[i] as number;
          const oversampler = (
            oversampleFactor === 4 ? this.oversamplers4x[channel] : this.oversamplers2x[channel]
          ) as Oversampler;
          oversampler.up(inputSample);
          const samples = oversampler.buffer;
          for (let slot = 0; slot < oversampleFactor; slot++) {
            const clean = samples[slot] as number;
            const wet = saturate(mode, clean * driveGain) * compensation;
            samples[slot] = clean + mix * (wet - clean);
          }
          let outputSample = oversampler.down();
          if (mode === MODE_TUBE) outputSample = (this.dcBlockers[channel] as OnePole).highpass(outputSample);
          // The tilt filter always runs, so moving Tone off 0% doesn't start it cold.
          const lowPassed = (this.tiltFilters[channel] as OnePole).process(outputSample);
          if (lowGain !== 1 || highGain !== 1)
            outputSample = lowPassed * lowGain + (outputSample - lowPassed) * highGain;
          (output[channel] as Float32Array)[i] = outputSample * outputGain;
        }
      }
      this.driveGainRamp.land();
      this.compensationRamp.land();
      this.lowRamp.land();
      this.highRamp.land();
      this.outputGainRamp.land();
    }
  }

  /** Reads the params at frame `i` and aims each derived gain at its new target, if its param changed. */
  private aim(params: ParamBlock<Params>, frame: number, frames: number): void {
    const driveDb = at(params.drive, frame);
    if (driveDb !== this.lastDriveDb) {
      this.lastDriveDb = driveDb;
      const gain = dbToGain(driveDb);
      this.driveGainRamp.aim(gain, frames);
      this.compensationRamp.aim(Math.pow(gain, DRIVE_COMPENSATION_EXPONENT), frames);
    }
    const tone = at(params.tone, frame);
    if (tone !== this.lastTone) {
      this.lastTone = tone;
      this.lowRamp.aim(dbToGain(-TILT_DB * tone), frames);
      this.highRamp.aim(dbToGain(TILT_DB * tone), frames);
    }
    const outputDb = at(params.output, frame);
    if (outputDb !== this.lastOutputDb) {
      this.lastOutputDb = outputDb;
      this.outputGainRamp.aim(dbToGain(outputDb), frames);
    }
  }
}
