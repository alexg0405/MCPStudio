import { at, dbToGain, EffectKernel, EnvelopeFollower, type ParamBlock } from '@agstudio/sdk/worklet';
import type { duckerParams } from './params';

type P = typeof duckerParams;

/** The key's level: near-instant attack; the release smooths low tones (≥ 30 Hz) enough not to retrigger. */
const LEVEL_ATTACK_MS = 0.05;
const LEVEL_RELEASE_MS = 30;
/** A hit on a tail that is still above the threshold: the level jumps 6 dB over its value 8 ms ago. */
const JUMP = 2;
const LOOKBACK_MS = 8;
/** After a hit the level has to fall 3 dB under the threshold before crossing it triggers again. */
const REARM = Math.pow(10, -3 / 20);
/** After a trigger, no new one for this long (one hit, one duck). */
const REFRACTORY_MS = 30;

const ATTACK = 0;
const HOLD = 1;
const RELEASE = 2;

/** The release shape: duck amount `e` (0–1) bent by `curve` (−1…1); 0 is linear. */
export function shapeDuck(e: number, curve: number): number {
  if (e <= 0) return 0;
  if (e >= 1 || curve === 0) return e;
  return Math.pow(e, Math.pow(2, -2 * curve));
}

/**
 * Sidechain ducker. An envelope follower on the key (the chosen track, or this track's own input
 * when none is chosen) finds each hit: the level crossing the threshold, or, on a tail that is still
 * above it, jumping 6 dB within 8 ms. Every hit plays the same duck: down to 1 − depth over
 * `attack`, `hold` there, back up over `release` bent by `curve` (positive is the classic pumping
 * shape). So a long kick's tail doesn't keep the duck down, a sustained key ducks once, and every
 * hit pumps the same. Tempo-synced shapes would need the transport in kernels (not yet available).
 */
export class DuckerKernel extends EffectKernel<P> {
  private readonly follower = new EnvelopeFollower(this.sampleRate, LEVEL_ATTACK_MS, LEVEL_RELEASE_MS);
  /** The level over the last LOOKBACK_MS (a ring). */
  private readonly history = new Float32Array(Math.max(1, Math.round((LOOKBACK_MS * this.sampleRate) / 1000)));
  private pos = 0;
  private armed = true;
  /** Duck amount 0–1 (before the release curve). */
  private amount = 0;
  private phase = RELEASE;
  /** Frames left in the hold phase. */
  private holdLeft = 0;
  /** Frames until a new hit may trigger. */
  private refractory = 0;

  override reset(): void {
    this.follower.reset();
    this.history.fill(0);
    this.armed = true;
    this.amount = 0;
    this.phase = RELEASE;
    this.holdLeft = 0;
    this.refractory = 0;
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
    const msToFrames = this.sampleRate / 1000;
    let threshold = Number.NaN;
    let thresholdGain = 0;
    for (let i = 0; i < n; i++) {
      const t = at(p.threshold, i);
      if (t !== threshold) {
        threshold = t;
        thresholdGain = dbToGain(t);
      }
      const a = kL[i] as number;
      const b = kR[i] as number;
      const aa = a < 0 ? -a : a;
      const ab = b < 0 ? -b : b;
      const level = this.follower.process(aa > ab ? aa : ab);
      const before = this.history[this.pos] as number;
      this.history[this.pos] = level;
      this.pos = this.pos + 1 < this.history.length ? this.pos + 1 : 0;
      if (level < thresholdGain * REARM) this.armed = true;
      if (this.refractory > 0) this.refractory -= 1;
      else if (level > thresholdGain && (this.armed || level > JUMP * before)) {
        this.phase = ATTACK;
        this.armed = false;
        this.refractory = REFRACTORY_MS * msToFrames;
      }
      if (this.phase === ATTACK) {
        const frames = at(p.attack, i) * msToFrames;
        this.amount = frames > 1 ? Math.min(1, this.amount + 1 / frames) : 1;
        if (this.amount >= 1) {
          this.phase = HOLD;
          this.holdLeft = at(p.hold, i) * msToFrames;
        }
      } else if (this.phase === HOLD) {
        if (this.holdLeft > 0) this.holdLeft -= 1;
        else this.phase = RELEASE;
      } else if (this.amount > 0) {
        const frames = at(p.release, i) * msToFrames;
        this.amount = frames > 1 ? Math.max(0, this.amount - 1 / frames) : 0;
      }
      const shaped = this.phase === RELEASE ? shapeDuck(this.amount, at(p.curve, i)) : this.amount;
      const g = shaped > 0 ? 1 - at(p.depth, i) * shaped : 1;
      outL[i] = (inL[i] as number) * g;
      outR[i] = (inR[i] as number) * g;
    }
  }
}
