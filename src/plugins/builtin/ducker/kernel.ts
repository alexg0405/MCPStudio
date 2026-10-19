import { at, dbToGain, EffectKernel, EnvelopeFollower, type ParamBlock } from '@agstudio/sdk/worklet';
import { PUMP_BEATS, type duckerParams } from './params';

type Params = typeof duckerParams;

/** The key's level: near-instant attack; the release smooths low tones (≥ 30 Hz) enough not to retrigger. */
const LEVEL_ATTACK_MS = 0.05;
const LEVEL_RELEASE_MS = 30;
/** A hit on a tail that is still above the threshold: the level jumps 6 dB over its value 8 ms ago. */
const JUMP_RATIO = 2;
const LOOKBACK_MS = 8;
/** After a hit the level has to fall 3 dB under the threshold before crossing it triggers again. */
const REARM_GAIN = Math.pow(10, -3 / 20);
/** After a trigger, no new one for this long (one hit, one duck). */
const REFRACTORY_MS = 30;

const PHASE_ATTACK = 0;
const PHASE_HOLD = 1;
const PHASE_RELEASE = 2;

/** The release shape: duck amount `e` (0–1) bent by `curve` (−1…1); 0 is linear. */
export function shapeDuck(duckAmount: number, curve: number): number {
  if (duckAmount <= 0) return 0;
  if (duckAmount >= 1 || curve === 0) return duckAmount;
  return Math.pow(duckAmount, Math.pow(2, -2 * curve));
}

/** The shortest release the tempo pump allows when a step is very short. */
const MIN_PUMP_RELEASE_MS = 1;

/**
 * Sidechain ducker. An envelope follower on the key (the chosen track, or this track's own input
 * when none is chosen) finds each hit: the level crossing the threshold, or, on a tail that is still
 * above it, jumping 6 dB within 8 ms. Every hit plays the same duck: down to 1 − depth over
 * `attack`, `hold` there, back up over `release` bent by `curve` (positive is the classic pumping
 * shape). So a long kick's tail doesn't keep the duck down, a sustained key ducks once, and every
 * hit pumps the same.
 *
 * Tempo mode needs no sidechain: while the song plays, every grid line of `rate` on the song
 * position is a hit (the same duck shape), and the release is shortened to fit in one step so the
 * pump always comes back up before the next beat. Stopped, it doesn't duck.
 */
export class DuckerKernel extends EffectKernel<Params> {
  private readonly follower = new EnvelopeFollower(this.sampleRate, LEVEL_ATTACK_MS, LEVEL_RELEASE_MS);
  /** The level over the last LOOKBACK_MS (a ring). */
  private readonly history = new Float32Array(Math.max(1, Math.round((LOOKBACK_MS * this.sampleRate) / 1000)));
  private historyPosition = 0;
  private isArmed = true;
  /** Duck amount 0–1 (before the release curve). */
  private duckAmount = 0;
  private duckPhase = PHASE_RELEASE;
  /** Frames left in the hold phase. */
  private holdFramesLeft = 0;
  /** Frames until a new hit may trigger. */
  private refractoryFramesLeft = 0;
  /** Tempo mode: the grid step the song is in (NaN after a stop or jump). */
  private gridStep = Number.NaN;

  override reset(): void {
    this.follower.reset();
    this.history.fill(0);
    this.isArmed = true;
    this.duckAmount = 0;
    this.duckPhase = PHASE_RELEASE;
    this.holdFramesLeft = 0;
    this.refractoryFramesLeft = 0;
    this.gridStep = Number.NaN;
  }

  override transportChanged(): void {
    this.gridStep = Number.NaN;
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
    const msToFrames = this.sampleRate / 1000;
    const isTempoMode = (params.mode[0] as number) >= 0.5;
    const transport = this.transport;
    const stepBeats = PUMP_BEATS[Math.round(params.rate[0] as number)] ?? 1;
    const stepMs = (stepBeats * 60000) / transport.bpm;
    /** A frame's length in steps (the tolerance for "playback started on a grid line"). */
    const frameSteps = transport.bpm / 60 / this.sampleRate / stepBeats;
    let lastThresholdDb = Number.NaN;
    let thresholdGain = 0;
    for (let i = 0; i < frameCount; i++) {
      if (isTempoMode) {
        if (transport.playing) {
          const stepPosition = transport.beatAt(i) / stepBeats;
          const gridStep = Math.floor(stepPosition + 1e-9);
          if (gridStep !== this.gridStep) {
            // A new step ducks, unless playback just started (or jumped) in the middle of one.
            if (!Number.isNaN(this.gridStep) || stepPosition - gridStep < frameSteps) this.duckPhase = PHASE_ATTACK;
            this.gridStep = gridStep;
          }
        } else this.gridStep = Number.NaN;
      } else {
        const thresholdDb = at(params.threshold, i);
        if (thresholdDb !== lastThresholdDb) {
          lastThresholdDb = thresholdDb;
          thresholdGain = dbToGain(thresholdDb);
        }
        const keyLeftSample = keyLeft[i] as number;
        const keyRightSample = keyRight[i] as number;
        const leftLevel = keyLeftSample < 0 ? -keyLeftSample : keyLeftSample;
        const rightLevel = keyRightSample < 0 ? -keyRightSample : keyRightSample;
        const level = this.follower.process(leftLevel > rightLevel ? leftLevel : rightLevel);
        const levelBefore = this.history[this.historyPosition] as number;
        this.history[this.historyPosition] = level;
        this.historyPosition = this.historyPosition + 1 < this.history.length ? this.historyPosition + 1 : 0;
        if (level < thresholdGain * REARM_GAIN) this.isArmed = true;
        if (this.refractoryFramesLeft > 0) this.refractoryFramesLeft -= 1;
        else if (level > thresholdGain && (this.isArmed || level > JUMP_RATIO * levelBefore)) {
          this.duckPhase = PHASE_ATTACK;
          this.isArmed = false;
          this.refractoryFramesLeft = REFRACTORY_MS * msToFrames;
        }
      }
      if (this.duckPhase === PHASE_ATTACK) {
        const frames = at(params.attack, i) * msToFrames;
        this.duckAmount = frames > 1 ? Math.min(1, this.duckAmount + 1 / frames) : 1;
        if (this.duckAmount >= 1) {
          this.duckPhase = PHASE_HOLD;
          this.holdFramesLeft = at(params.hold, i) * msToFrames;
        }
      } else if (this.duckPhase === PHASE_HOLD) {
        if (this.holdFramesLeft > 0) this.holdFramesLeft -= 1;
        else this.duckPhase = PHASE_RELEASE;
      } else if (this.duckAmount > 0) {
        let releaseMs = at(params.release, i);
        if (isTempoMode) {
          // Back up before the next step.
          const room = stepMs - at(params.attack, i) - at(params.hold, i);
          const fit = room > MIN_PUMP_RELEASE_MS ? room : MIN_PUMP_RELEASE_MS;
          if (releaseMs > fit) releaseMs = fit;
        }
        const frames = releaseMs * msToFrames;
        this.duckAmount = frames > 1 ? Math.max(0, this.duckAmount - 1 / frames) : 0;
      }
      const shaped =
        this.duckPhase === PHASE_RELEASE ? shapeDuck(this.duckAmount, at(params.curve, i)) : this.duckAmount;
      const gain = shaped > 0 ? 1 - at(params.depth, i) * shaped : 1;
      outLeft[i] = (inLeft[i] as number) * gain;
      outRight[i] = (inRight[i] as number) * gain;
    }
  }
}
