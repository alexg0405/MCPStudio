import { at, dbToGain, EffectKernel, OnePole, Oversampler, type ParamBlock } from '@agstudio/sdk/worklet';
import type { saturatorParams } from './params';

type P = typeof saturatorParams;

const TAPE = 0;
const TUBE = 1;
/** Tube bias: the curve is shifted so its two halves clip differently (even harmonics). */
const BIAS = 0.35;
/** The curve's value at the bias point (from softClip itself, so silence stays exactly silent). */
const TANH_BIAS = softClip(BIAS);
/** Keeps the tube curve's small-signal gain at 1. */
const TUBE_NORM = 1 / (1 - TANH_BIAS * TANH_BIAS);
/** Drive is partly compensated: quiet sounds get a little louder, loud ones level off. */
const COMPENSATION = -0.7;
const TILT_HZ = 800;
const TILT_DB = 6;
const DC_HZ = 8;

/** tanh(x) by Lambert's continued fraction (within 1e-4 of it), exactly ±1 beyond ±4.97. */
export function softClip(x: number): number {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  return (x * (135135 + x2 * (17325 + x2 * (378 + x2)))) / (135135 + x2 * (62370 + x2 * (3150 + 28 * x2)));
}

/** The saturation curve of a mode for a driven sample. */
export function saturate(mode: number, u: number): number {
  if (mode === TAPE) return softClip(u);
  if (mode === TUBE) return (softClip(u + BIAS) - TANH_BIAS) * TUBE_NORM;
  return u > 1 ? 1 : u < -1 ? -1 : u;
}

/**
 * Saturator: drive into a tape (tanh), tube (biased tanh: asymmetric, even harmonics, DC removed
 * afterwards) or hard-clip curve, at 2× or 4× the sample rate (SDK Oversampler: IIR halfbands, no
 * latency). The dry/wet mix happens in the oversampled domain, so dry and wet share the same
 * filters and stay in phase. Then a tilt EQ (±6 dB around 800 Hz) and the output level.
 */
export class SaturatorKernel extends EffectKernel<P> {
  private readonly os2 = [new Oversampler(2), new Oversampler(2)];
  private readonly os4 = [new Oversampler(4), new Oversampler(4)];
  private readonly tilt = [
    new OnePole().setCutoff(TILT_HZ, this.sampleRate),
    new OnePole().setCutoff(TILT_HZ, this.sampleRate),
  ];
  private readonly dc = [
    new OnePole().setCutoff(DC_HZ, this.sampleRate),
    new OnePole().setCutoff(DC_HZ, this.sampleRate),
  ];
  private driveDb = Number.NaN;
  private driveGain = 1;
  private comp = 1;
  private toneValue = Number.NaN;
  private low = 1;
  private high = 1;
  private outDb = Number.NaN;
  private outGain = 1;
  private factor = 0;

  override reset(): void {
    for (const o of this.os2) o.reset();
    for (const o of this.os4) o.reset();
    for (const f of this.tilt) f.reset();
    for (const f of this.dc) f.reset();
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const mode = Math.round(p.mode[0] as number);
    const factor = Math.round(p.oversample[0] as number) === 1 ? 4 : 2;
    if (factor !== this.factor) {
      // The other oversampler starts from silence rather than from where it was left.
      if (this.factor !== 0) for (const o of factor === 4 ? this.os4 : this.os2) o.reset();
      this.factor = factor;
    }
    for (let i = 0; i < n; i++) {
      this.params(at(p.drive, i), at(p.tone, i), at(p.output, i));
      const mix = at(p.mix, i);
      const drive = this.driveGain;
      const comp = this.comp;
      for (let c = 0; c < 2; c++) {
        const x = ((input[c] ?? input[0]) as Float32Array)[i] as number;
        const os = (factor === 4 ? this.os4[c] : this.os2[c]) as Oversampler;
        os.up(x);
        const b = os.buffer;
        for (let k = 0; k < factor; k++) {
          const clean = b[k] as number;
          const wet = saturate(mode, clean * drive) * comp;
          b[k] = clean + mix * (wet - clean);
        }
        let y = os.down();
        if (mode === TUBE) y = (this.dc[c] as OnePole).highpass(y);
        // The tilt filter always runs, so moving Tone off 0% doesn't start it cold.
        const lo = (this.tilt[c] as OnePole).process(y);
        if (this.low !== 1 || this.high !== 1) y = lo * this.low + (y - lo) * this.high;
        (output[c] as Float32Array)[i] = y * this.outGain;
      }
    }
  }

  private params(driveDb: number, tone: number, outDb: number): void {
    if (driveDb !== this.driveDb) {
      this.driveDb = driveDb;
      this.driveGain = dbToGain(driveDb);
      this.comp = Math.pow(this.driveGain, COMPENSATION);
    }
    if (tone !== this.toneValue) {
      this.toneValue = tone;
      this.low = dbToGain(-TILT_DB * tone);
      this.high = dbToGain(TILT_DB * tone);
    }
    if (outDb !== this.outDb) {
      this.outDb = outDb;
      this.outGain = dbToGain(outDb);
    }
  }
}
