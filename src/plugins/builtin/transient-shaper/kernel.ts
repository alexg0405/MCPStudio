import { at, dbToGain, EffectKernel, EnvelopeFollower, OnePole, Ramp, type ParamBlock } from '@agstudio/sdk/worklet';
import type { transientParams } from './params';

type Params = typeof transientParams;

/** The output level is recomputed every CONTROL frames and ramps between (see GateKernel). */
const CONTROL_FRAMES = 32;
/** 20 / ln(10): dB = DB_PER_NEPER · ln(ratio). */
const DB_PER_NEPER = 8.685889638065035;
const NEPER_PER_DB = 1 / DB_PER_NEPER;
/** The shaper never lifts by more than this or cuts by more than MAX_CUT (dB). */
const MAX_BOOST_DB = 18;
const MAX_CUT_DB = 30;
/** Under this level (−70 dBFS) tails aren't lifted: no pumping the noise floor up. */
const TAIL_FLOOR = 3e-4;
/** Release of the detectors that find the start of a sound. */
const ATTACK_RELEASE_MS = 80;
/** Fast and slow release of the detectors that find the tail. */
const TAIL_FAST_MS = 20;
const TAIL_SLOW_MS = 300;

/**
 * Transient shaper. Four envelope followers on the stereo-linked level: a fast and a slow attack
 * (same release) differ only at the start of a sound, so their ratio in dB measures "how much
 * attack"; a fast and a slow release differ only in the tail ("how much sustain"). The gain in dB
 * is attack · attack-dB + sustain · sustain-dB, limited and smoothed. Both at 0%: unchanged.
 */
export class TransientKernel extends EffectKernel<Params> {
  private readonly fastAttackFollower = new EnvelopeFollower(this.sampleRate, 0.1, ATTACK_RELEASE_MS);
  private readonly slowAttackFollower = new EnvelopeFollower(this.sampleRate, 20, ATTACK_RELEASE_MS);
  private readonly fastTailFollower = new EnvelopeFollower(this.sampleRate, 0.1, TAIL_FAST_MS);
  private readonly slowTailFollower = new EnvelopeFollower(this.sampleRate, 0.1, TAIL_SLOW_MS);
  private readonly gainSmoother = new OnePole().setTime(0.001, this.sampleRate);
  private attackLengthMs = -1;
  private outputDb = Number.NaN;
  private readonly outputGainRamp = new Ramp();

  override reset(): void {
    this.fastAttackFollower.reset();
    this.slowAttackFollower.reset();
    this.fastTailFollower.reset();
    this.slowTailFollower.reset();
    this.gainSmoother.reset();
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    for (let blockStart = 0; blockStart < frameCount; blockStart += CONTROL_FRAMES) {
      const blockEnd = Math.min(frameCount, blockStart + CONTROL_FRAMES);
      // The slow detector's time constant is set once per interval, not per frame: its coefficients are
      // private to the follower, and a 32-frame step moves a 5–100 ms constant by well under 1 %.
      const attackLengthMs = at(params.length, blockStart);
      if (attackLengthMs !== this.attackLengthMs) {
        this.attackLengthMs = attackLengthMs;
        this.slowAttackFollower.setTimes(attackLengthMs, ATTACK_RELEASE_MS);
      }
      const outputDb = at(params.output, blockStart);
      if (outputDb !== this.outputDb) {
        this.outputDb = outputDb;
        this.outputGainRamp.aim(dbToGain(outputDb), blockEnd - blockStart);
      }
      let outputGain = this.outputGainRamp.value;
      const outputGainSlope = this.outputGainRamp.slope;
      for (let i = blockStart; i < blockEnd; i++) {
        outputGain += outputGainSlope;
        const leftSample = inLeft[i] as number;
        const rightSample = inRight[i] as number;
        const leftLevel = leftSample < 0 ? -leftSample : leftSample;
        const rightLevel = rightSample < 0 ? -rightSample : rightSample;
        const level = leftLevel > rightLevel ? leftLevel : rightLevel;
        // The detectors always run, so turning a knob doesn't start them cold.
        const fastAttack = this.fastAttackFollower.process(level);
        const slowAttack = this.slowAttackFollower.process(level);
        const fastTail = this.fastTailFollower.process(level);
        const slowTail = this.slowTailFollower.process(level);
        const attackAmount = at(params.attack, i);
        const sustainAmount = at(params.sustain, i);
        let gainDb = 0;
        if (attackAmount !== 0 && slowAttack > 1e-9)
          gainDb += attackAmount * DB_PER_NEPER * Math.log(fastAttack / slowAttack);
        if (sustainAmount !== 0 && fastTail > 1e-9 && slowTail > TAIL_FLOOR)
          gainDb += sustainAmount * DB_PER_NEPER * Math.log(slowTail / fastTail);
        if (gainDb > MAX_BOOST_DB) gainDb = MAX_BOOST_DB;
        else if (gainDb < -MAX_CUT_DB) gainDb = -MAX_CUT_DB;
        const shaped = this.gainSmoother.process(gainDb);
        const gain = (shaped === 0 ? 1 : Math.exp(NEPER_PER_DB * shaped)) * outputGain;
        const mix = at(params.mix, i);
        if (gain === 1) {
          outLeft[i] = leftSample;
          outRight[i] = rightSample;
        } else if (mix >= 1) {
          outLeft[i] = leftSample * gain;
          outRight[i] = rightSample * gain;
        } else {
          const wetGain = 1 + mix * (gain - 1);
          outLeft[i] = leftSample * wetGain;
          outRight[i] = rightSample * wetGain;
        }
      }
      this.outputGainRamp.land();
    }
  }
}
