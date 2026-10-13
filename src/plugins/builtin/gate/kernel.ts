import { at, dbToGain, EffectKernel, EnvelopeFollower, type ParamBlock } from '@agstudio/sdk/worklet';
import type { gateParams } from './params';

type P = typeof gateParams;

/** The key detector: a fast peak follower. */
const DETECT_ATTACK_MS = 0.05;
const DETECT_RELEASE_MS = 5;
/** Once open, the gate closes only this far below the threshold (no chatter around it). */
export const HYSTERESIS_DB = 4;

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
  private attack = -1;
  private release = -1;
  private attackCoef = 0;
  private releaseCoef = 0;

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
    let threshold = Number.NaN;
    let openAt = 0;
    let closeAt = 0;
    let range = Number.NaN;
    let floor = 0;
    for (let i = 0; i < n; i++) {
      const a = kL[i] as number;
      const b = kR[i] as number;
      if (listen) {
        outL[i] = a;
        outR[i] = b;
        continue;
      }
      const t = at(p.threshold, i);
      if (t !== threshold) {
        threshold = t;
        openAt = dbToGain(t);
        closeAt = dbToGain(t - HYSTERESIS_DB);
      }
      const r = at(p.range, i);
      if (r !== range) {
        range = r;
        floor = dbToGain(r);
      }
      this.timing(at(p.attack, i), at(p.release, i));
      const aa = a < 0 ? -a : a;
      const ab = b < 0 ? -b : b;
      const level = this.detector.process(aa > ab ? aa : ab);
      if (level > openAt || (this.open && level > closeAt)) {
        this.open = true;
        this.holdLeft = at(p.hold, i) * msToFrames;
      } else if (this.holdLeft > 0) this.holdLeft -= 1;
      else this.open = false;
      const target = this.open || this.holdLeft > 0 ? 1 : 0;
      const c = target > this.env ? this.attackCoef : this.releaseCoef;
      let e = target + c * (this.env - target);
      if (e < 1e-9) e = 0;
      this.env = e;
      const g = floor + (1 - floor) * e;
      outL[i] = (inL[i] as number) * g;
      outR[i] = (inR[i] as number) * g;
    }
  }

  private timing(attack: number, release: number): void {
    if (attack === this.attack && release === this.release) return;
    this.attack = attack;
    this.release = release;
    this.attackCoef = Math.exp(-1 / ((Math.max(attack, 0.001) / 1000) * this.sampleRate));
    this.releaseCoef = Math.exp(-1 / ((Math.max(release, 0.001) / 1000) * this.sampleRate));
  }
}
