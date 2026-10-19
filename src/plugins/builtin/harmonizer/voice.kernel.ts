// One harmony voice: a pitch shifter whose pitch glides to the interval it is told to sing, and its level and pan.
import { pow2, type DelayLine } from '@agstudio/sdk/worklet';
import { PitchShifter } from './shifter.kernel';

/** Seconds a voice takes to glide to a new interval (fast enough to follow a melody, too slow to click). */
const GLIDE_SEC = 0.012;
/** Seconds a voice's level and pan take to settle after a change (also its fade in and out). */
const GAIN_SEC = 0.005;
/** A voice quieter than this (linear) counts as silent and is not computed. */
const SILENT_GAIN = 1e-5;

export class HarmonyVoice {
  private readonly shifter: PitchShifter;
  private readonly glideCoefficient: number;
  private readonly gainCoefficient: number;
  /** The shift the voice is gliding to, and the one it has reached, cents; `ratioCents` is the one `ratio` was computed from. */
  private goalCents = 0;
  private cents = 0;
  private ratioCents = Number.NaN;
  private ratio = 1;
  /** False until the first goal arrives: a voice that does not know its interval yet stays silent. */
  private hasGoal = false;
  private targetLeft = 0;
  private targetRight = 0;
  private gainLeft = 0;
  private gainRight = 0;
  private isSounding = false;
  /** This frame's sound in the left and right channel (set by `render`). */
  left = 0;
  right = 0;

  constructor(sampleRate: number, restFrames: number) {
    this.shifter = new PitchShifter(sampleRate, restFrames);
    this.glideCoefficient = 1 - Math.exp(-1 / (GLIDE_SEC * sampleRate));
    this.gainCoefficient = 1 - Math.exp(-1 / (GAIN_SEC * sampleRate));
  }

  reset(): void {
    this.shifter.reset();
    this.hasGoal = false;
    this.isSounding = false;
    this.gainLeft = 0;
    this.gainRight = 0;
    this.ratioCents = Number.NaN;
    this.left = 0;
    this.right = 0;
  }

  /** The voice's current shift, cents (what the voice has glided to so far). */
  get shiftCents(): number {
    return this.cents;
  }

  /** The detector's latest result, passed on to the shifter. */
  setPitch(periodFrames: number, isVoiced: boolean): void {
    this.shifter.setPitch(periodFrames, isVoiced);
  }

  /** Where the voice should sing, as cents above the input. The first goal is taken at once, later ones are glided to. */
  setGoalCents(goalCents: number): void {
    this.goalCents = goalCents;
    if (this.hasGoal) return;
    this.hasGoal = true;
    this.cents = goalCents;
  }

  /** How loud the voice is in each channel (0, 0 = off: it fades out and stops costing anything). */
  setTargetGains(left: number, right: number): void {
    this.targetLeft = left;
    this.targetRight = right;
  }

  /** Computes this frame into `left` and `right`. The delay line must already hold the current input frame. */
  render(line: DelayLine, keepsFormants: boolean): void {
    const isWanted = this.hasGoal && (this.targetLeft > 0 || this.targetRight > 0);
    const goalLeft = isWanted ? this.targetLeft : 0;
    const goalRight = isWanted ? this.targetRight : 0;
    this.gainLeft += (goalLeft - this.gainLeft) * this.gainCoefficient;
    this.gainRight += (goalRight - this.gainRight) * this.gainCoefficient;
    if (!isWanted && this.gainLeft < SILENT_GAIN && this.gainRight < SILENT_GAIN) {
      this.fallSilent();
      return;
    }
    this.isSounding = true;
    this.cents += (this.goalCents - this.cents) * this.glideCoefficient;
    if (this.cents !== this.ratioCents) {
      this.ratioCents = this.cents;
      this.ratio = pow2(this.cents / 1200);
    }
    const sound = this.shifter.next(line, this.ratio, keepsFormants);
    this.left = sound * this.gainLeft;
    this.right = sound * this.gainRight;
  }

  /** Stops computing: the next time the voice is wanted it starts from a clean shifter. */
  private fallSilent(): void {
    if (this.isSounding) {
      this.isSounding = false;
      this.shifter.reset();
      this.gainLeft = 0;
      this.gainRight = 0;
    }
    this.left = 0;
    this.right = 0;
  }
}
