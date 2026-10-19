import { at, DelayLine, EffectKernel, LinkwitzRiley, type ParamBlock } from '@agstudio/sdk/worklet';
import { MONO_OFF_HZ, type stereoParams } from './params';

type Params = typeof stereoParams;

/** Params that cost a filter design are read every CONTROL frames. */
const CONTROL_FRAMES = 16;
/** Time constants (seconds) for switching "mono bass" on/off and for moving the widener delay. */
const MONO_SWITCH_SEC = 0.01;
const HAAS_GLIDE_SEC = 0.02;
const MAX_HAAS_MS = 30;

/**
 * Stereo tool in mid/side: an optional phase flip on the way in, "mono bass" (the side signal
 * loses everything under the crossover through a Linkwitz-Riley high-pass, and the mid gets the
 * matching allpass so both stay in phase), width (side × width), a Haas widener (the right side
 * delayed by a few ms) and balance. At its defaults it returns the input unchanged.
 */
export class StereoKernel extends EffectKernel<Params> {
  private readonly sideFilter = new LinkwitzRiley().set(100, this.sampleRate);
  private readonly midFilter = new LinkwitzRiley().set(100, this.sampleRate);
  private readonly haasLine = new DelayLine(Math.ceil(((MAX_HAAS_MS + 2) * this.sampleRate) / 1000));
  private readonly switchSmoothing = 1 - Math.exp(-1 / (MONO_SWITCH_SEC * this.sampleRate));
  private readonly haasSmoothing = 1 - Math.exp(-1 / (HAAS_GLIDE_SEC * this.sampleRate));
  /** 0–1: how much of the mono-bass path is heard (glides when it is switched on or off). */
  private monoAmount = 0;
  /** The widener's delay in frames (glides to the param). */
  private haasFrames = 0;
  private countdown = 0;
  private monoAmountTarget = 0;
  /** The first block starts at the settings instead of gliding to them. */
  private isPrimed = false;

  override reset(): void {
    this.sideFilter.reset();
    this.midFilter.reset();
    this.haasLine.clear();
    this.countdown = 0;
    this.isPrimed = false;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const flipChoice = Math.round(params.flip[0] as number);
    const flipLeft = flipChoice === 1 || flipChoice === 3 ? -1 : 1;
    const flipRight = flipChoice >= 2 ? -1 : 1;
    const msToFrames = this.sampleRate / 1000;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        const crossoverHz = at(params.monoBelow, i);
        this.monoAmountTarget = crossoverHz > MONO_OFF_HZ ? 1 : 0;
        if (this.monoAmountTarget > 0) {
          this.sideFilter.set(crossoverHz, this.sampleRate);
          this.midFilter.set(crossoverHz, this.sampleRate);
        }
      }
      this.countdown--;
      if (!this.isPrimed) {
        this.isPrimed = true;
        this.monoAmount = this.monoAmountTarget;
        this.haasFrames = at(params.haas, i) * msToFrames;
      }
      const leftSample = flipLeft * (inLeft[i] as number);
      const rightSample = flipRight * (inRight[i] as number);
      const width = at(params.width, i);
      // The filters always run, so switching mono bass on doesn't start them cold.
      const mid = 0.5 * (leftSample + rightSample);
      const side = 0.5 * (leftSample - rightSample);
      this.sideFilter.split(side);
      const alignedMid = this.midFilter.allpass(mid);
      let monoNow = this.monoAmount + (this.monoAmountTarget - this.monoAmount) * this.switchSmoothing;
      if (Math.abs(monoNow - this.monoAmountTarget) < 1e-6) monoNow = this.monoAmountTarget;
      this.monoAmount = monoNow;
      let left: number;
      let right: number;
      if (monoNow === 0 && width === 1) {
        left = leftSample;
        right = rightSample;
      } else {
        const midOut = mid + monoNow * (alignedMid - mid);
        const sideOut = width * (side + monoNow * (this.sideFilter.high - side));
        left = midOut + sideOut;
        right = midOut - sideOut;
      }
      // Haas widener: the right side a few ms late.
      const haasTarget = at(params.haas, i) * msToFrames;
      let delayFrames = this.haasFrames + (haasTarget - this.haasFrames) * this.haasSmoothing;
      if (Math.abs(delayFrames - haasTarget) < 1e-4) delayFrames = haasTarget;
      this.haasFrames = delayFrames;
      this.haasLine.write(right);
      if (delayFrames > 0)
        right = delayFrames >= 1 ? this.haasLine.readCubic(delayFrames) : this.haasLine.read(delayFrames);
      const balance = at(params.balance, i);
      outLeft[i] = balance > 0 ? left * (1 - balance) : left;
      outRight[i] = balance < 0 ? right * (1 + balance) : right;
    }
  }
}
