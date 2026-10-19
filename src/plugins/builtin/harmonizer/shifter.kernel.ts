// A pitch shifter for one voice that reads a shared delay line. It is the idea of Tune's shifter (a splicer that
// jumps whole periods, plus pitch-synchronous grains that keep the formants), written for one mono voice.
import type { DelayLine } from '@agstudio/sdk/worklet';

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
/** Slowest grain spacing ratio the window width is planned for: down to an octave below. */
const SLOWEST_RATIO = 0.5;

/** One Hann curve over 0..1, shared by every voice (built once, outside the audio callback). */
const GRAIN_WINDOW = (() => {
  const curve = new Float32Array(GRAIN_WINDOW_SIZE + 1);
  for (let i = 0; i <= GRAIN_WINDOW_SIZE; i++) curve[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / GRAIN_WINDOW_SIZE);
  return curve;
})();

/**
 * One shifted copy of the voice. The read head moves through the delay line at `ratio` times the speed of the
 * input (so the pitch is `ratio` times the input's); when it strays too far from its resting delay a second head
 * starts a whole number of detected periods away (the same point of the waveform, so nothing cancels) and a
 * short crossfade hands over to it. With Keep formants, pitch-synchronous grains of two periods are laid down
 * one new period apart (period / ratio) instead, each read at the voice's own speed, so the vowel's colour stays
 * where it was while the pitch moves.
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
  /** Per grain: its delay behind the write head (constant: it plays at speed 1), the offset from its centre, its half width (0 = free). */
  private readonly grainDelay = new Float64Array(MAX_GRAINS);
  private readonly grainOffset = new Float64Array(MAX_GRAINS);
  private readonly grainHalfWidth = new Float64Array(MAX_GRAINS);
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

  /** The next frame of the shifted voice, `ratio` times the input's pitch. Call after the line has been written. */
  next(line: DelayLine, ratio: number, keepsFormants: boolean): number {
    const driftPerFrame = 1 - ratio;
    this.readHead += driftPerFrame;
    if (this.spliceFrame >= 0) this.incomingHead += driftPerFrame;
    else if (Math.abs(this.readHead - this.restFrames) > this.maxHeadOffset) this.startSplice();
    let sound = line.readCubic(this.readHead);
    if (this.spliceFrame >= 0) {
      const progress = (this.spliceFrame + 1) / this.spliceFrames;
      const incomingShare = 0.5 - 0.5 * Math.cos(Math.PI * progress);
      sound += incomingShare * (line.readCubic(this.incomingHead) - sound);
      if (++this.spliceFrame >= this.spliceFrames) {
        this.readHead = this.incomingHead;
        this.spliceFrame = -1;
      }
    }
    if (!keepsFormants) {
      if (this.isGrainSequenceRunning) this.stopGrains();
      return sound;
    }
    const grainShare = this.grains(line, ratio);
    if (grainShare > 0) sound += (this.grainSound - sound) * grainShare;
    return sound;
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
  private grains(line: DelayLine, ratio: number): number {
    const clock = this.grainClock++;
    if (this.isVoiced) this.spawnGrainsDue(clock, ratio);
    else if (this.isGrainSequenceRunning) this.isGrainSequenceRunning = false;
    let windowSum = 0;
    let soundSum = 0;
    for (let grain = 0; grain < MAX_GRAINS; grain++) {
      const halfWidth = this.grainHalfWidth[grain] as number;
      if (halfWidth === 0) continue;
      const offsetFromCentre = this.grainOffset[grain] as number;
      const windowPosition = ((offsetFromCentre + halfWidth) / (2 * halfWidth)) * GRAIN_WINDOW_SIZE;
      const windowIndex = windowPosition | 0;
      const windowLow = GRAIN_WINDOW[windowIndex] as number;
      const windowHigh = GRAIN_WINDOW[windowIndex + 1] as number;
      const weight = windowLow + (windowHigh - windowLow) * (windowPosition - windowIndex);
      windowSum += weight;
      soundSum += weight * line.readCubic(this.grainDelay[grain] as number);
      if (offsetFromCentre + 1 >= halfWidth) this.grainHalfWidth[grain] = 0;
      else this.grainOffset[grain] = offsetFromCentre + 1;
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
      const grainHalf = this.nextHalfWidth;
      const freeSlot = this.freeGrainSlot();
      if (freeSlot >= 0) {
        const periodsApart = Math.round((grainCentre - this.restFrames - this.lastCentre) / periodFrames);
        const sourceCentre = this.lastCentre + periodsApart * periodFrames;
        this.lastCentre = sourceCentre;
        this.grainDelay[freeSlot] = grainCentre - sourceCentre;
        this.grainOffset[freeSlot] = -grainHalf;
        this.grainHalfWidth[freeSlot] = grainHalf;
        this.grainsSinceStart++;
      }
      const spacing = periodFrames / (ratio > SLOWEST_RATIO ? ratio : SLOWEST_RATIO);
      this.nextCentre = grainCentre + spacing;
      // Two periods wide: a window that reaches into the neighbouring periods would carry their pulses along and
      // keep the original pitch in a fall.
      this.nextHalfWidth = periodFrames;
    }
  }

  /** A grain slot that is not sounding (-1 when all are). */
  private freeGrainSlot(): number {
    for (let grain = 0; grain < MAX_GRAINS; grain++) {
      if (this.grainHalfWidth[grain] === 0) return grain;
    }
    return -1;
  }

  /** Lets every grain go (the sequence starts afresh at the next voiced note). */
  private stopGrains(): void {
    this.grainHalfWidth.fill(0);
    this.isGrainSequenceRunning = false;
  }
}
