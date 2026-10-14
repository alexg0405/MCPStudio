import { at, dbToGain, EffectKernel, EnvelopeFollower, type ParamBlock } from '@agstudio/sdk/worklet';
import { PUMP_BEATS, type duckerParams } from './params';

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
  /** Tempo mode: the grid step the song is in (NaN after a stop or jump). */
  private step = Number.NaN;

  override reset(): void {
    this.follower.reset();
    this.history.fill(0);
    this.armed = true;
    this.amount = 0;
    this.phase = RELEASE;
    this.holdLeft = 0;
    this.refractory = 0;
    this.step = Number.NaN;
  }

  override transportChanged(): void {
    this.step = Number.NaN;
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
    const tempo = (p.mode[0] as number) >= 0.5;
    const transport = this.transport;
    const stepBeats = PUMP_BEATS[Math.round(p.rate[0] as number)] ?? 1;
    const stepMs = (stepBeats * 60000) / transport.bpm;
    /** A frame's length in steps (the tolerance for "playback started on a grid line"). */
    const frameSteps = transport.bpm / 60 / this.sampleRate / stepBeats;
    let threshold = Number.NaN;
    let thresholdGain = 0;
    for (let i = 0; i < n; i++) {
      if (tempo) {
        if (transport.playing) {
          const pos = transport.beatAt(i) / stepBeats;
          const step = Math.floor(pos + 1e-9);
          if (step !== this.step) {
            // A new step ducks, unless playback just started (or jumped) in the middle of one.
            if (!Number.isNaN(this.step) || pos - step < frameSteps) this.phase = ATTACK;
            this.step = step;
          }
        } else this.step = Number.NaN;
      } else {
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
        let release = at(p.release, i);
        if (tempo) {
          // Back up before the next step.
          const room = stepMs - at(p.attack, i) - at(p.hold, i);
          const fit = room > MIN_PUMP_RELEASE_MS ? room : MIN_PUMP_RELEASE_MS;
          if (release > fit) release = fit;
        }
        const frames = release * msToFrames;
        this.amount = frames > 1 ? Math.max(0, this.amount - 1 / frames) : 0;
      }
      const shaped = this.phase === RELEASE ? shapeDuck(this.amount, at(p.curve, i)) : this.amount;
      const g = shaped > 0 ? 1 - at(p.depth, i) * shaped : 1;
      outL[i] = (inL[i] as number) * g;
      outR[i] = (inR[i] as number) * g;
    }
  }
}
