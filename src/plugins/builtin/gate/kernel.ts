import { at, dbToGain, EffectKernel, EnvelopeFollower, Ramp, type ParamBlock } from '@agstudio/sdk/worklet';
import type { gateParams } from './params';

type P = typeof gateParams;

/** The key detector: a fast peak follower. */
const DETECT_ATTACK_MS = 0.05;
const DETECT_RELEASE_MS = 5;
/** Once open, the gate closes only this far below the threshold (no chatter around it). */
export const HYSTERESIS_DB = 4;
/**
 * The params are read, and the gains and coefficients derived from them recomputed, every CONTROL
 * frames; in between they ramp linearly. Automated params cost an add per frame, not two exp/pow calls.
 */
const CONTROL = 32;

/**
 * Noise gate keyed by the sidechain (the chosen track, or its own input when none is chosen). It
 * opens when the key's peak level rises above the threshold, stays open while it is within
 * HYSTERESIS_DB below it plus `hold`, then closes. Opening and closing are exponential with the
 * attack and release time constants; closed, the signal is turned down by `range`.
 */
export class GateKernel extends EffectKernel<P> {
  private readonly detector = new EnvelopeFollower(this.sampleRate, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
  /** 0 (closed) … 1 (open). */
  private env = 0;
  private open = false;
  private holdLeft = 0;
  /** The param values last read: a derived value is only re-aimed when its param has changed. */
  private threshold = Number.NaN;
  private range = Number.NaN;
  private attack = Number.NaN;
  private release = Number.NaN;
  private readonly openAt = new Ramp();
  private readonly closeAt = new Ramp();
  private readonly floor = new Ramp();
  private readonly attackCoef = new Ramp();
  private readonly releaseCoef = new Ramp();

  override reset(): void {
    this.detector.reset();
    this.env = 0;
    this.open = false;
    this.holdLeft = 0;
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    n: number,
    p: ParamBlock<P>,
    sidechain?: Float32Array[],
  ): void {
    const key = sidechain ?? input;
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const kL = key[0] as Float32Array;
    const kR = (key[1] ?? kL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const listen = (p.listen[0] as number) >= 0.5;
    const msToFrames = this.sampleRate / 1000;
    for (let s = 0; s < n; s += CONTROL) {
      const end = Math.min(n, s + CONTROL);
      this.aim(p, s, end - s);
      let openAt = this.openAt.value;
      let closeAt = this.closeAt.value;
      let floor = this.floor.value;
      let attackCoef = this.attackCoef.value;
      let releaseCoef = this.releaseCoef.value;
      const dOpenAt = this.openAt.slope;
      const dCloseAt = this.closeAt.slope;
      const dFloor = this.floor.slope;
      const dAttack = this.attackCoef.slope;
      const dRelease = this.releaseCoef.slope;
      for (let i = s; i < end; i++) {
        const a = kL[i] as number;
        const b = kR[i] as number;
        if (listen) {
          outL[i] = a;
          outR[i] = b;
          continue;
        }
        openAt += dOpenAt;
        closeAt += dCloseAt;
        floor += dFloor;
        attackCoef += dAttack;
        releaseCoef += dRelease;
        const aa = a < 0 ? -a : a;
        const ab = b < 0 ? -b : b;
        const level = this.detector.process(aa > ab ? aa : ab);
        if (level > openAt || (this.open && level > closeAt)) {
          this.open = true;
          this.holdLeft = at(p.hold, i) * msToFrames;
        } else if (this.holdLeft > 0) this.holdLeft -= 1;
        else this.open = false;
        const target = this.open || this.holdLeft > 0 ? 1 : 0;
        const c = target > this.env ? attackCoef : releaseCoef;
        let e = target + c * (this.env - target);
        if (e < 1e-9) e = 0;
        this.env = e;
        const g = floor + (1 - floor) * e;
        outL[i] = (inL[i] as number) * g;
        outR[i] = (inR[i] as number) * g;
      }
      this.openAt.land();
      this.closeAt.land();
      this.floor.land();
      this.attackCoef.land();
      this.releaseCoef.land();
    }
  }

  /** Reads the params at frame `i` and aims each derived value at its new target, if its param changed. */
  private aim(p: ParamBlock<P>, i: number, frames: number): void {
    const t = at(p.threshold, i);
    if (t !== this.threshold) {
      this.threshold = t;
      this.openAt.aim(dbToGain(t), frames);
      this.closeAt.aim(dbToGain(t - HYSTERESIS_DB), frames);
    }
    const r = at(p.range, i);
    if (r !== this.range) {
      this.range = r;
      this.floor.aim(dbToGain(r), frames);
    }
    const attack = at(p.attack, i);
    if (attack !== this.attack) {
      this.attack = attack;
      this.attackCoef.aim(coefficient(attack, this.sampleRate), frames);
    }
    const release = at(p.release, i);
    if (release !== this.release) {
      this.release = release;
      this.releaseCoef.aim(coefficient(release, this.sampleRate), frames);
    }
  }
}

/** The per-frame coefficient of a time constant in ms (0.001 ms at least). */
function coefficient(ms: number, sampleRate: number): number {
  return Math.exp(-1 / ((Math.max(ms, 0.001) / 1000) * sampleRate));
}
