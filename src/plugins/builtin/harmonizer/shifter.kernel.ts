// A pitch shifter for one voice that reads a shared ring of the input. It is the idea of Tune's shifter (a splicer that
// jumps whole periods, plus pitch-synchronous grains that keep the formants), written for one mono voice.
import { hermiteWeights, type SampleRing } from './ring.kernel';

/** Length of a splice's crossfade, seconds. */
const SPLICE_SEC = 0.004;
/** The period assumed when none was found yet, seconds (a splice then just jumps this far). */
const FALLBACK_PERIOD_SEC = 0.005;
/** Grains that can sound at once in "keep formants" mode (up to 4 overlap at the largest shift, plus the next). */
const MAX_GRAINS = 8;
/** Size of the grain window table (a Hann curve, read with interpolation). */
const GRAIN_WINDOW_SIZE = 512;
const TWO_PI = Math.PI * 2;
/** Once this many grains have started in a sequence, the grains supply all of the sound (before that they fade in against the splice). */
const GRAINS_FOR_FULL_SHARE = 2;
/** Slowest grain spacing ratio the fade-in is planned for: down to an octave below. */
const SLOWEST_RATIO = 0.5;

/** One Hann curve over 0..1, shared by every voice (built once, outside the audio callback). */
const GRAIN_WINDOW = (() => {
  const curve = new Float32Array(GRAIN_WINDOW_SIZE + 1);
  for (let i = 0; i <= GRAIN_WINDOW_SIZE; i++) curve[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / GRAIN_WINDOW_SIZE);
  return curve;
})();

/**
 * One shifted copy of the voice. The read head moves through the ring at `ratio` times the speed of the input (so
 * the pitch is `ratio` times the input's); when it strays too far from its resting delay a second head starts a whole
 * number of detected periods away (the same point of the waveform, so nothing cancels) and a short crossfade hands
 * over to it. With Keep formants, pitch-synchronous grains of two periods are laid down one new period apart
 * (period / ratio) instead, each read at the voice's own speed, so the vowel's colour stays where it was while the
 * pitch moves.
 *
 * `restFrames` is both the delay the heads rest at and the latency the whole plugin reports.
 */
export class PitchShifter {
  private readonly spliceFrames: number;
  /** How far the head may stray from the resting delay before splicing. */
  private readonly maxHeadOffset: number;
  /** The playing head's delay, frames, and the incoming one's during a splice. */
  private readHead: number;
  private incomingHead = 0;
  /** Frames into the current splice (-1: none). */
  private spliceFrame = -1;
  /** The last period found, frames, and whether the last detection found a pitch. */
  private periodFrames: number;
  private isVoiced = false;

  // ---- Keep formants: grains read at the voice's own speed (pitch-synchronous overlap-add) ----
  /**
   * Per grain: where it is in its window (0 to GRAIN_WINDOW_SIZE) and how far that moves each frame (0 = the slot is
   * free), the whole part of its delay behind the newest sample (constant: it plays at speed 1) and the four cubic
   * weights for the fraction left over.
   */
  private readonly grainWindowPosition = new Float64Array(MAX_GRAINS);
  private readonly grainWindowStep = new Float64Array(MAX_GRAINS);
  private readonly grainWholeDelay = new Int32Array(MAX_GRAINS);
  private readonly grainWeights = new Float64Array(4 * MAX_GRAINS);
  /** A frame counter (only counted while the mode is on), and the sequence of grains: next centre and half width, last analysis centre. */
  private grainClock = 0;
  private isGrainSequenceRunning = false;
  private grainsSinceStart = 0;
  private nextCentre = 0;
  private nextHalfWidth = 0;
  private lastCentre = 0;
  /** The grains' sound for this frame (set by `grains`). */
  private grainSound = 0;

  constructor(
    sampleRate: number,
    private readonly restFrames: number,
  ) {
    this.spliceFrames = Math.max(16, Math.round(SPLICE_SEC * sampleRate));
    this.maxHeadOffset = restFrames - this.spliceFrames - 8;
    this.readHead = restFrames;
    this.periodFrames = FALLBACK_PERIOD_SEC * sampleRate;
  }

  /** Back to the resting state (no splice, no grains): used when a voice starts sounding again. */
  reset(): void {
    this.readHead = this.restFrames;
    this.spliceFrame = -1;
    this.stopGrains();
  }

  /** The detector's latest result: the period of the voice in frames, and whether it found one. */
  setPitch(periodFrames: number, isVoiced: boolean): void {
    if (isVoiced) this.periodFrames = periodFrames;
    this.isVoiced = isVoiced;
  }

  /** The next frame of the shifted voice, `ratio` times the input's pitch. Call after the ring has been written. */
  next(ring: SampleRing, ratio: number, keepsFormants: boolean): number {
    const driftPerFrame = 1 - ratio;
    this.readHead += driftPerFrame;
    if (this.spliceFrame >= 0) this.incomingHead += driftPerFrame;
    else if (Math.abs(this.readHead - this.restFrames) > this.maxHeadOffset) this.startSplice();
    if (!keepsFormants) {
      if (this.isGrainSequenceRunning) this.stopGrains();
      return this.spliceSound(ring);
    }
    const grainShare = this.grains(ring, ratio);
    // Once the grains supply everything the splice is not heard: only keep its heads moving.
    if (grainShare >= 1) {
      this.skipSplice();
      return this.grainSound;
    }
    const sound = this.spliceSound(ring);
    return grainShare > 0 ? sound + (this.grainSound - sound) * grainShare : sound;
  }

  /** The splicing shifter's frame: the playing head, crossfaded to the incoming one during a splice. */
  private spliceSound(ring: SampleRing): number {
    let sound = ring.readCubic(this.readHead);
    if (this.spliceFrame < 0) return sound;
    const progress = (this.spliceFrame + 1) / this.spliceFrames;
    const incomingShare = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    sound += incomingShare * (ring.readCubic(this.incomingHead) - sound);
    this.skipSplice();
    return sound;
  }

  /** Moves a splice in progress on by one frame, handing over to the incoming head at its end. */
  private skipSplice(): void {
    if (this.spliceFrame < 0) return;
    if (++this.spliceFrame < this.spliceFrames) return;
    this.readHead = this.incomingHead;
    this.spliceFrame = -1;
  }

  /** Hands over to a head a whole number of periods back towards the resting delay. */
  private startSplice(): void {
    const period = this.periodFrames;
    const distance = Math.abs(this.readHead - this.restFrames) + this.maxHeadOffset;
    const jump = period * Math.max(1, Math.round(distance / period));
    this.incomingHead = this.readHead < this.restFrames ? this.readHead + jump : this.readHead - jump;
    // Never read closer than the cubic reader allows.
    if (this.incomingHead < 2) this.incomingHead += period * Math.ceil((2 - this.incomingHead) / period);
    this.spliceFrame = 0;
  }

  /**
   * Keep formants. A grain is two periods of the voice under a Hann window, read at the voice's own speed (so its
   * formants stay), and grains are laid down one new period apart (period / ratio), each taken from the nearest
   * point of the voice's own period grid, so a rise repeats some periods and a fall skips some. Returns how much
   * of the sound this frame the grains supply (0-1; it ramps in and out with the first and last grain), with the
   * sound in `grainSound`.
   */
  private grains(ring: SampleRing, ratio: number): number {
    const clock = this.grainClock++;
    if (this.isVoiced) this.spawnGrainsDue(clock, ratio);
    else if (this.isGrainSequenceRunning) this.isGrainSequenceRunning = false;
    let windowSum = 0;
    let soundSum = 0;
    for (let grain = 0; grain < MAX_GRAINS; grain++) {
      const step = this.grainWindowStep[grain] as number;
      if (step === 0) continue;
      const position = this.grainWindowPosition[grain] as number;
      const windowIndex = position | 0;
      const windowLow = GRAIN_WINDOW[windowIndex] as number;
      const windowHigh = GRAIN_WINDOW[windowIndex + 1] as number;
      const weight = windowLow + (windowHigh - windowLow) * (position - windowIndex);
      windowSum += weight;
      soundSum += weight * ring.readWeighted(this.grainWholeDelay[grain] as number, this.grainWeights, 4 * grain);
      const nextPosition = position + step;
      if (nextPosition >= GRAIN_WINDOW_SIZE) this.grainWindowStep[grain] = 0;
      else this.grainWindowPosition[grain] = nextPosition;
    }
    // Overlapping grains (a rise) are divided by their window sum so the level stays even. Grains that do not overlap
    // (a fall) are left as they are: dividing a sparse sum would lift the quiet stretch between two pulses to full
    // level and put a pulse back at every original period, so the pitch would not move.
    this.grainSound = soundSum / (windowSum > 1 ? windowSum : 1);
    if (this.isGrainSequenceRunning && this.grainsSinceStart >= GRAINS_FOR_FULL_SHARE) return 1;
    if (windowSum < 1e-6) return 0;
    const coverage = windowSum / (0.9 * (ratio > SLOWEST_RATIO ? ratio : SLOWEST_RATIO));
    return coverage > 1 ? 1 : coverage;
  }

  /** Starts every grain that is due at frame `clock` (one at a time at the usual rates). */
  private spawnGrainsDue(clock: number, ratio: number): void {
    const periodFrames = this.periodFrames;
    if (!this.isGrainSequenceRunning) {
      this.isGrainSequenceRunning = true;
      this.grainsSinceStart = 0;
      this.nextHalfWidth = periodFrames;
      this.nextCentre = clock + periodFrames;
      // The first grain reads exactly the resting delay behind: no shift, no offset.
      this.lastCentre = this.nextCentre - this.restFrames;
    }
    let spawned = 0;
    while (clock >= this.nextCentre - this.nextHalfWidth && spawned++ < 4) {
      const grainCentre = this.nextCentre;
      const freeSlot = this.freeGrainSlot();
      if (freeSlot >= 0) {
        const periodsApart = Math.round((grainCentre - this.restFrames - this.lastCentre) / periodFrames);
        const sourceCentre = this.lastCentre + periodsApart * periodFrames;
        this.lastCentre = sourceCentre;
        this.startGrain(freeSlot, grainCentre - sourceCentre, this.nextHalfWidth);
        this.grainsSinceStart++;
      }
      const spacing = periodFrames / (ratio > SLOWEST_RATIO ? ratio : SLOWEST_RATIO);
      this.nextCentre = grainCentre + spacing;
      // Two periods wide: a window that reaches into the neighbouring periods would carry their pulses along and
      // keep the original pitch in a fall.
      this.nextHalfWidth = periodFrames;
    }
  }

  /** Sets a grain going in `slot`: it reads `delayFrames` behind the newest sample, under a window `2 * halfWidth` frames long. */
  private startGrain(slot: number, delayFrames: number, halfWidth: number): void {
    // The cubic reader needs a frame either side: keep the read at least one frame back.
    const limited = delayFrames < 1 ? 1 : delayFrames;
    const whole = Math.floor(limited);
    hermiteWeights(limited - whole, this.grainWeights, 4 * slot);
    this.grainWholeDelay[slot] = whole;
    this.grainWindowPosition[slot] = 0;
    this.grainWindowStep[slot] = GRAIN_WINDOW_SIZE / (2 * halfWidth);
  }

  /** A grain slot that is not sounding (-1 when all are). */
  private freeGrainSlot(): number {
    for (let grain = 0; grain < MAX_GRAINS; grain++) {
      if (this.grainWindowStep[grain] === 0) return grain;
    }
    return -1;
  }

  /** Lets every grain go (the sequence starts afresh at the next voiced note). */
  private stopGrains(): void {
    this.grainWindowStep.fill(0);
    this.isGrainSequenceRunning = false;
  }
}
