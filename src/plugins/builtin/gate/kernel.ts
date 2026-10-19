import { at, dbToGain, EffectKernel, EnvelopeFollower, Ramp, type ParamBlock } from '@agstudio/sdk/worklet';
import type { gateParams } from './params';

type Params = typeof gateParams;

/** The key detector: a fast peak follower. */
const DETECT_ATTACK_MS = 0.05;
const DETECT_RELEASE_MS = 5;
/** Once open, the gate closes only this far below the threshold (no chatter around it). */
export const HYSTERESIS_DB = 4;
/**
 * The params are read, and the gains and coefficients derived from them recomputed, every CONTROL
 * frames; in between they ramp linearly. Automated params cost an add per frame, not two exp/pow calls.
 */
const CONTROL_FRAMES = 32;

/**
 * Noise gate keyed by the sidechain (the chosen track, or its own input when none is chosen). It
 * opens when the key's peak level rises above the threshold, stays open while it is within
 * HYSTERESIS_DB below it plus `hold`, then closes. Opening and closing are exponential with the
 * attack and release time constants; closed, the signal is turned down by `range`.
 */
export class GateKernel extends EffectKernel<Params> {
  private readonly detector = new EnvelopeFollower(this.sampleRate, DETECT_ATTACK_MS, DETECT_RELEASE_MS);
  /** 0 (closed) … 1 (open). */
  private openness = 0;
  private isOpen = false;
  private holdFramesLeft = 0;
  /** The param values last read: a derived value is only re-aimed when its param has changed. */
  private thresholdDb = Number.NaN;
  private rangeDb = Number.NaN;
  private attackMs = Number.NaN;
  private releaseMs = Number.NaN;
  private readonly openLevel = new Ramp();
  private readonly closeLevel = new Ramp();
  private readonly closedGain = new Ramp();
  private readonly attackCoefficient = new Ramp();
  private readonly releaseCoefficient = new Ramp();

  override reset(): void {
    this.detector.reset();
    this.openness = 0;
    this.isOpen = false;
    this.holdFramesLeft = 0;
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    frameCount: number,
    params: ParamBlock<Params>,
    sidechain?: Float32Array[],
  ): void {
    const key = sidechain ?? input;
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const keyLeft = key[0] as Float32Array;
    const keyRight = (key[1] ?? keyLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const isListening = (params.listen[0] as number) >= 0.5;
    const msToFrames = this.sampleRate / 1000;
    for (let blockStart = 0; blockStart < frameCount; blockStart += CONTROL_FRAMES) {
      const blockEnd = Math.min(frameCount, blockStart + CONTROL_FRAMES);
      this.aim(params, blockStart, blockEnd - blockStart);
      let openLevel = this.openLevel.value;
      let closeLevel = this.closeLevel.value;
      let closedGain = this.closedGain.value;
      let attackCoefficient = this.attackCoefficient.value;
      let releaseCoefficient = this.releaseCoefficient.value;
      const openLevelSlope = this.openLevel.slope;
      const closeLevelSlope = this.closeLevel.slope;
      const closedGainSlope = this.closedGain.slope;
      const attackSlope = this.attackCoefficient.slope;
      const releaseSlope = this.releaseCoefficient.slope;
      for (let i = blockStart; i < blockEnd; i++) {
        const keyLeftSample = keyLeft[i] as number;
        const keyRightSample = keyRight[i] as number;
        if (isListening) {
          outLeft[i] = keyLeftSample;
          outRight[i] = keyRightSample;
          continue;
        }
        openLevel += openLevelSlope;
        closeLevel += closeLevelSlope;
        closedGain += closedGainSlope;
        attackCoefficient += attackSlope;
        releaseCoefficient += releaseSlope;
        const leftLevel = keyLeftSample < 0 ? -keyLeftSample : keyLeftSample;
        const rightLevel = keyRightSample < 0 ? -keyRightSample : keyRightSample;
        const level = this.detector.process(leftLevel > rightLevel ? leftLevel : rightLevel);
        if (level > openLevel || (this.isOpen && level > closeLevel)) {
          this.isOpen = true;
          this.holdFramesLeft = at(params.hold, i) * msToFrames;
        } else if (this.holdFramesLeft > 0) this.holdFramesLeft -= 1;
        else this.isOpen = false;
        const targetOpenness = this.isOpen || this.holdFramesLeft > 0 ? 1 : 0;
        const coefficient = targetOpenness > this.openness ? attackCoefficient : releaseCoefficient;
        let nextOpenness = targetOpenness + coefficient * (this.openness - targetOpenness);
        if (nextOpenness < 1e-9) nextOpenness = 0;
        this.openness = nextOpenness;
        const gain = closedGain + (1 - closedGain) * nextOpenness;
        outLeft[i] = (inLeft[i] as number) * gain;
        outRight[i] = (inRight[i] as number) * gain;
      }
      this.openLevel.land();
      this.closeLevel.land();
      this.closedGain.land();
      this.attackCoefficient.land();
      this.releaseCoefficient.land();
    }
  }

  /** Reads the params at frame `i` and aims each derived value at its new target, if its param changed. */
  private aim(params: ParamBlock<Params>, frame: number, frames: number): void {
    const thresholdDb = at(params.threshold, frame);
    if (thresholdDb !== this.thresholdDb) {
      this.thresholdDb = thresholdDb;
      this.openLevel.aim(dbToGain(thresholdDb), frames);
      this.closeLevel.aim(dbToGain(thresholdDb - HYSTERESIS_DB), frames);
    }
    const rangeDb = at(params.range, frame);
    if (rangeDb !== this.rangeDb) {
      this.rangeDb = rangeDb;
      this.closedGain.aim(dbToGain(rangeDb), frames);
    }
    const attack = at(params.attack, frame);
    if (attack !== this.attackMs) {
      this.attackMs = attack;
      this.attackCoefficient.aim(coefficient(attack, this.sampleRate), frames);
    }
    const release = at(params.release, frame);
    if (release !== this.releaseMs) {
      this.releaseMs = release;
      this.releaseCoefficient.aim(coefficient(release, this.sampleRate), frames);
    }
  }
}

/** The per-frame coefficient of a time constant in ms (0.001 ms at least). */
function coefficient(ms: number, sampleRate: number): number {
  return Math.exp(-1 / ((Math.max(ms, 0.001) / 1000) * sampleRate));
}
