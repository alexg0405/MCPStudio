import { at, DelayLine, EffectKernel, LinkwitzRiley, type ParamBlock } from '@agstudio/sdk/worklet';
import { MONO_OFF_HZ, type stereoParams } from './params';

type P = typeof stereoParams;

/** Params that cost a filter design are read every CONTROL frames. */
const CONTROL = 16;
/** Time constants (seconds) for switching "mono bass" on/off and for moving the widener delay. */
const SWITCH_TIME = 0.01;
const HAAS_TIME = 0.02;
const MAX_HAAS_MS = 30;

/**
 * Stereo tool in mid/side: an optional phase flip on the way in, "mono bass" (the side signal
 * loses everything under the crossover through a Linkwitz-Riley high-pass, and the mid gets the
 * matching allpass so both stay in phase), width (side × width), a Haas widener (the right side
 * delayed by a few ms) and balance. At its defaults it returns the input unchanged.
 */
export class StereoKernel extends EffectKernel<P> {
  private readonly side = new LinkwitzRiley().set(100, this.sampleRate);
  private readonly mid = new LinkwitzRiley().set(100, this.sampleRate);
  private readonly line = new DelayLine(Math.ceil(((MAX_HAAS_MS + 2) * this.sampleRate) / 1000));
  private readonly switchCoef = 1 - Math.exp(-1 / (SWITCH_TIME * this.sampleRate));
  private readonly haasCoef = 1 - Math.exp(-1 / (HAAS_TIME * this.sampleRate));
  /** 0–1: how much of the mono-bass path is heard (glides when it is switched on or off). */
  private mono = 0;
  /** The widener's delay in frames (glides to the param). */
  private haas = 0;
  private countdown = 0;
  private monoTarget = 0;
  /** The first block starts at the settings instead of gliding to them. */
  private primed = false;

  override reset(): void {
    this.side.reset();
    this.mid.reset();
    this.line.clear();
    this.countdown = 0;
    this.primed = false;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const flip = Math.round(p.flip[0] as number);
    const fl = flip === 1 || flip === 3 ? -1 : 1;
    const fr = flip >= 2 ? -1 : 1;
    const msToFrames = this.sampleRate / 1000;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        const freq = at(p.monoBelow, i);
        this.monoTarget = freq > MONO_OFF_HZ ? 1 : 0;
        if (this.monoTarget > 0) {
          this.side.set(freq, this.sampleRate);
          this.mid.set(freq, this.sampleRate);
        }
      }
      this.countdown--;
      if (!this.primed) {
        this.primed = true;
        this.mono = this.monoTarget;
        this.haas = at(p.haas, i) * msToFrames;
      }
      const l = fl * (inL[i] as number);
      const r = fr * (inR[i] as number);
      const width = at(p.width, i);
      // The filters always run, so switching mono bass on doesn't start them cold.
      const m = 0.5 * (l + r);
      const s = 0.5 * (l - r);
      this.side.split(s);
      const mAligned = this.mid.allpass(m);
      let mono = this.mono + (this.monoTarget - this.mono) * this.switchCoef;
      if (Math.abs(mono - this.monoTarget) < 1e-6) mono = this.monoTarget;
      this.mono = mono;
      let left: number;
      let right: number;
      if (mono === 0 && width === 1) {
        left = l;
        right = r;
      } else {
        const m2 = m + mono * (mAligned - m);
        const s2 = width * (s + mono * (this.side.high - s));
        left = m2 + s2;
        right = m2 - s2;
      }
      // Haas widener: the right side a few ms late.
      const target = at(p.haas, i) * msToFrames;
      let d = this.haas + (target - this.haas) * this.haasCoef;
      if (Math.abs(d - target) < 1e-4) d = target;
      this.haas = d;
      this.line.write(right);
      if (d > 0) right = d >= 1 ? this.line.readCubic(d) : this.line.read(d);
      const balance = at(p.balance, i);
      outL[i] = balance > 0 ? left * (1 - balance) : left;
      outR[i] = balance < 0 ? right * (1 + balance) : right;
    }
  }
}
