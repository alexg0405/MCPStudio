import { at, dbToGain, EffectKernel, EnvelopeFollower, OnePole, Ramp, type ParamBlock } from '@agstudio/sdk/worklet';
import type { transientParams } from './params';

type P = typeof transientParams;

/** The output level is recomputed every CONTROL frames and ramps between (see GateKernel). */
const CONTROL = 32;
/** 20 / ln(10): dB = DB_PER_NEPER · ln(ratio). */
const DB_PER_NEPER = 8.685889638065035;
const NEPER_PER_DB = 1 / DB_PER_NEPER;
/** The shaper never lifts by more than this or cuts by more than MAX_CUT (dB). */
const MAX_BOOST = 18;
const MAX_CUT = 30;
/** Under this level (−70 dBFS) tails aren't lifted: no pumping the noise floor up. */
const FLOOR = 3e-4;
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
export class TransientKernel extends EffectKernel<P> {
  private readonly fast = new EnvelopeFollower(this.sampleRate, 0.1, ATTACK_RELEASE_MS);
  private readonly slow = new EnvelopeFollower(this.sampleRate, 20, ATTACK_RELEASE_MS);
  private readonly tailFast = new EnvelopeFollower(this.sampleRate, 0.1, TAIL_FAST_MS);
  private readonly tailSlow = new EnvelopeFollower(this.sampleRate, 0.1, TAIL_SLOW_MS);
  private readonly smooth = new OnePole().setTime(0.001, this.sampleRate);
  private length = -1;
  private outDb = Number.NaN;
  private readonly outGain = new Ramp();

  override reset(): void {
    this.fast.reset();
    this.slow.reset();
    this.tailFast.reset();
    this.tailSlow.reset();
    this.smooth.reset();
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    for (let s = 0; s < n; s += CONTROL) {
      const end = Math.min(n, s + CONTROL);
      // The slow detector's time constant is set once per interval, not per frame: its coefficients are
      // private to the follower, and a 32-frame step moves a 5–100 ms constant by well under 1 %.
      const length = at(p.length, s);
      if (length !== this.length) {
        this.length = length;
        this.slow.setTimes(length, ATTACK_RELEASE_MS);
      }
      const out = at(p.output, s);
      if (out !== this.outDb) {
        this.outDb = out;
        this.outGain.aim(dbToGain(out), end - s);
      }
      let outGain = this.outGain.value;
      const dOutGain = this.outGain.slope;
      for (let i = s; i < end; i++) {
        outGain += dOutGain;
        const l = inL[i] as number;
        const r = inR[i] as number;
        const al = l < 0 ? -l : l;
        const ar = r < 0 ? -r : r;
        const level = al > ar ? al : ar;
        // The detectors always run, so turning a knob doesn't start them cold.
        const f = this.fast.process(level);
        const sl = this.slow.process(level);
        const tf = this.tailFast.process(level);
        const ts = this.tailSlow.process(level);
        const attack = at(p.attack, i);
        const sustain = at(p.sustain, i);
        let db = 0;
        if (attack !== 0 && sl > 1e-9) db += attack * DB_PER_NEPER * Math.log(f / sl);
        if (sustain !== 0 && tf > 1e-9 && ts > FLOOR) db += sustain * DB_PER_NEPER * Math.log(ts / tf);
        if (db > MAX_BOOST) db = MAX_BOOST;
        else if (db < -MAX_CUT) db = -MAX_CUT;
        const shaped = this.smooth.process(db);
        const g = (shaped === 0 ? 1 : Math.exp(NEPER_PER_DB * shaped)) * outGain;
        const mix = at(p.mix, i);
        if (g === 1) {
          outL[i] = l;
          outR[i] = r;
        } else if (mix >= 1) {
          outL[i] = l * g;
          outR[i] = r * g;
        } else {
          const w = 1 + mix * (g - 1);
          outL[i] = l * w;
          outR[i] = r * w;
        }
      }
      this.outGain.land();
    }
  }
}
