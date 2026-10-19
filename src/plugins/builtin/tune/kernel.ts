import {
  at,
  clamp,
  DelayLine,
  EffectKernel,
  pow2,
  Readings,
  Yin,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { RANGE_HZ, RANGES, TUNE_SCALES, tuneLatencyFrames, type tuneParams } from './params';

type Params = typeof tuneParams;

/** A new pitch estimate every HOP frames. */
const HOP_FRAMES = 256;
/** Keep the current note until another is this much (semitones) nearer: no flicker in between. */
const HYSTERESIS = 0.2;
/** Detections less sure than this count as unvoiced. */
const MIN_CONFIDENCE = 0.6;
/** Corrections smaller than this (cents) let the shifter rest (output = the delayed input). */
const REST_CENTS = 1;
/**
 * The pitch detector reads a steady voice a cent or two off at 300 Hz and up (more the higher it is), which on its own
 * kept a held note from ever counting as "in tune". When the plain estimate puts the voice between REST_CENTS and this
 * many cents from a note (a bit more than that error at 800 Hz), the detector's closer estimate is asked for too, and the
 * rest decision uses it. Under REST_CENTS the shifter rests anyway; further out the correction is real, and the closer
 * estimate is not worth its cost.
 */
const REFINE_WITHIN_CENTS = 8;
/**
 * How fast a resting read head drifts back to its centre, frames per frame (≈ 6 cents): only what is left after the jumps
 * below (less than half a period, or less than one frame), so the drift is short and stays far under a vibrato.
 */
const REST_RATE = 0.0035;
/** The drift until a rest has lasted REST_HOLD_SEC: what it always was (≈ 3 cents). */
const REST_RATE_SLOW = 0.002;
/**
 * After a correction ends the read head is a few milliseconds off its centre. While the voice sounds it jumps back a
 * whole number of periods (the same waveform point, with the splice's crossfade); once no pitch has been found for this
 * many detections (≈ 43 ms) nothing pitched needs lining up and it crosses straight to the centre. Either way the output
 * is the delayed input again within a few milliseconds, instead of after seconds of drifting.
 */
const UNPITCHED_HOPS = 8;
/** The correction must have stayed below REST_CENTS this long (seconds) before the head is brought back (a glide crossing a note is not an end). */
const REST_HOLD_SEC = 0.03;
/** Largest correction applied, semitones. */
const MAX_SHIFT_SEMITONES = 12;
/** Length of a splice's crossfade, seconds. */
const SPLICE_SEC = 0.004;
/** The period assumed when none was found yet, seconds (a splice then just jumps this far). */
const FALLBACK_PERIOD_SEC = 0.005;

/** Played notes the kernel keeps track of at once (a chord of more is rare; the oldest goes). */
const MAX_HELD = 16;
/** Time constants (seconds) of the slow pitch line and the note average that "keep natural drift" compares. */
const DRIFT_SLOW_TAU_SEC = 0.1;
const DRIFT_AVERAGE_TAU_SEC = 1;
/** Seconds the added vibrato takes to fade in after a note starts. */
const VIBRATO_FADE_SEC = 0.35;
/** Grains that can sound at once in "keep formants" mode (up to 4 overlap at the largest shift, plus the next). */
const MAX_GRAINS = 8;
/** Size of the grain window table (a Hann curve, read with interpolation). */
const GRAIN_WINDOW_SIZE = 512;
const TWO_PI = Math.PI * 2;

/** One Hann curve over 0..1, shared by every kernel (built once, outside process()). */
const GRAIN_WINDOW = (() => {
  const curve = new Float32Array(GRAIN_WINDOW_SIZE + 1);
  for (let i = 0; i <= GRAIN_WINDOW_SIZE; i++) curve[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / GRAIN_WINDOW_SIZE);
  return curve;
})();

/** Pitch-class masks (bit n = n semitones above the root) of every scale, by enum index. */
const SCALE_MASKS = TUNE_SCALES.map((scale) =>
  scale.intervals.reduce<number>((mask, interval) => mask | (1 << interval), 0),
);

/** Semitones either side of a pitch that the nearest-note search looks through (half an octave). */
const SEARCH_SEMITONES = 6;

/**
 * The nearest note of a key and scale to a pitch (fractional MIDI note), keeping `currentNote` while
 * it is within HYSTERESIS of being as near (−1 for none). `scaleMask` has bit n set for the note n
 * semitones above `keyRoot` (a pitch class, 0 = C).
 */
export function nearestNote(pitchMidi: number, keyRoot: number, scaleMask: number, currentNote: number): number {
  let bestNote = -1;
  let bestDistance = Infinity;
  const nearestWhole = Math.round(pitchMidi);
  for (let note = nearestWhole - SEARCH_SEMITONES; note <= nearestWhole + SEARCH_SEMITONES; note++) {
    const semitonesAboveRoot = (((note - keyRoot) % 12) + 12) % 12;
    if (!(scaleMask & (1 << semitonesAboveRoot))) continue;
    const distance = Math.abs(pitchMidi - note);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestNote = note;
    }
  }
  if (currentNote >= 0 && bestNote !== currentNote) {
    const semitonesAboveRoot = (((currentNote - keyRoot) % 12) + 12) % 12;
    const isInScale = scaleMask & (1 << semitonesAboveRoot);
    if (isInScale && Math.abs(pitchMidi - currentNote) <= bestDistance + HYSTERESIS) return currentNote;
  }
  return bestNote;
}

/**
 * Scale pitch correction. YIN (SDK) finds the pitch every 256 frames; the target is the nearest
 * note of the key and scale (with hysteresis), and the correction glides there with Retune speed.
 *
 * The shifter is a pitch-synchronous splicer: one read head moves through a delay line at the
 * corrected speed; when it drifts too far from its resting delay, a second head starts a whole
 * number of detected periods away (so both read the same point of the waveform) and a short
 * crossfade hands over to it. No phase cancellation, no pitch bias. With nothing to correct the
 * head rests at the centre: the output is exactly the input delayed by the reported latency, and
 * the dry signal for the mix is read at the same delay. When a correction ends (it stays under a
 * cent for 30 ms) the head goes home the same way it splices: a whole number of periods while the
 * voice sounds, straight to the centre once no pitch has been found for ~43 ms, so the output is
 * the delayed input again within milliseconds of a pause and under a second of a held note.
 */
export class TuneKernel extends EffectKernel<Params> {
  readonly latency = tuneLatencyFrames(this.sampleRate);
  private readonly spliceFrames = Math.max(16, Math.round(SPLICE_SEC * this.sampleRate));
  /** How far the head may stray from the centre before splicing. */
  private readonly maxHeadOffset = this.latency - this.spliceFrames - 8;
  private readonly delayLines = [new DelayLine(4 * this.latency + 64), new DelayLine(4 * this.latency + 64)];
  private readonly detectors: Yin[];
  private readonly meter = new Readings(this.host, ['pitch', 'target', 'cents'] as const);
  private rangeIndex = -1;
  private framesSinceDetection = 0;
  private targetNote = -1;
  /** The correction being applied, cents (glides towards `goalCents`). */
  private correctionCents = 0;
  /**
   * What `goalCents` would be if it came from the detector's closer estimate. It is never applied to the sound; it only
   * tells whether the voice is in tune, see `isInTuneByCloserEstimate`.
   */
  private restGoalCents = 0;
  /** `headDriftPerFrame` is the read-speed change for `driftComputedForCents` (the cents it was computed from). */
  private driftComputedForCents = Number.NaN;
  private headDriftPerFrame = 0;
  private goalCents = 0;
  /** The Retune speed last seen (ms) and the one-pole coefficient that glides the correction at that speed. */
  private retuneSpeedMs = -1;
  private glideCoefficient = 1;
  /** The playing head's delay, frames, and the incoming one's during a splice. */
  private readHead: number;
  private incomingHead = 0;
  /** Frames into the current splice (−1: none). */
  private spliceFrame = -1;
  /** The last period found, frames. */
  private periodFrames: number;

  // ---- Played notes (Target = notes) ----
  private readonly heldKeys = new Int16Array(MAX_HELD);
  private readonly heldIds = new Int32Array(MAX_HELD);
  private heldCount = 0;

  // ---- Keep natural drift: the singer's slow line and its long average, in cents ----
  private slowLineCents = 0;
  private averageLineCents = 0;
  private needsDriftRestart = true;
  private readonly slowLineSmoothing = 1 - Math.exp(-HOP_FRAMES / (DRIFT_SLOW_TAU_SEC * this.sampleRate));
  private readonly averageLineSmoothing = 1 - Math.exp(-HOP_FRAMES / (DRIFT_AVERAGE_TAU_SEC * this.sampleRate));

  // ---- Added vibrato ----
  private vibratoPhase = 0;
  private vibratoLevel = 0;
  private readonly vibratoFadeStep = HOP_FRAMES / (VIBRATO_FADE_SEC * this.sampleRate);

  // ---- Keep formants: overlapped grains read at their own speed (pitch-synchronous OLA) ----
  /** Per grain: its delay behind the write head (constant: it plays at speed 1), the offset from its centre, its half width (0 = free). */
  private readonly grainDelay = new Float64Array(MAX_GRAINS);
  private readonly grainOffset = new Float64Array(MAX_GRAINS);
  private readonly grainHalfWidth = new Float64Array(MAX_GRAINS);
  /** A frame counter (only counted while the mode is on), and the sequence of grains: next centre and half width, last analysis centre. */
  private grainClock = 0;
  private isGrainSequenceRunning = false;
  private nextCentre = 0;
  private nextHalfWidth = 0;
  private lastCentre = 0;
  /** True while the last detection found a pitch with something to pull to. */
  private isVoiced = false;
  /** Detections in a row that found no pitch at all (the voice is silent or unpitched). */
  private unpitchedHops = 0;
  /** Frames the correction has been under REST_CENTS, and how many it takes to count as over. */
  private restFrames = 0;
  private readonly restHoldFrames = Math.round(REST_HOLD_SEC * this.sampleRate);

  constructor(host: KernelHost) {
    super(host);
    this.detectors = RANGES.map((r) => {
      const [minHz, maxHz] = RANGE_HZ[r];
      return new Yin(this.sampleRate, { minHz, maxHz });
    });
    this.readHead = this.latency;
    this.periodFrames = FALLBACK_PERIOD_SEC * this.sampleRate;
    const v = this.meter.values;
    v.pitch = 0;
    v.target = -1;
    v.cents = 0;
  }

  override reset(): void {
    for (const l of this.delayLines) l.clear();
    for (const d of this.detectors) d.reset();
    this.targetNote = -1;
    this.correctionCents = 0;
    this.goalCents = 0;
    this.restGoalCents = 0;
    this.readHead = this.latency;
    this.spliceFrame = -1;
    this.heldCount = 0;
    this.needsDriftRestart = true;
    this.vibratoLevel = 0;
    this.unpitchedHops = 0;
    this.restFrames = 0;
    this.stopGrains();
  }

  // ---- Played notes ----

  override noteOn(key: number, _velocity: number, noteId: number): void {
    for (let i = 0; i < this.heldCount; i++) {
      if (this.heldIds[i] === noteId) {
        this.heldKeys[i] = key;
        return;
      }
    }
    if (this.heldCount === MAX_HELD) {
      // The oldest goes.
      this.heldKeys.copyWithin(0, 1);
      this.heldIds.copyWithin(0, 1);
      this.heldCount--;
    }
    this.heldKeys[this.heldCount] = key;
    this.heldIds[this.heldCount] = noteId;
    this.heldCount++;
  }

  override noteOff(noteId: number): void {
    for (let i = 0; i < this.heldCount; i++) {
      if (this.heldIds[i] !== noteId) continue;
      this.heldKeys.copyWithin(i, i + 1, this.heldCount);
      this.heldIds.copyWithin(i, i + 1, this.heldCount);
      this.heldCount--;
      return;
    }
  }

  override allNotesOff(): void {
    this.heldCount = 0;
  }

  /** The held note nearest to a pitch (fractional MIDI), keeping `current` while it is held and within HYSTERESIS of as near (-1: none held). */
  private nearestHeld(pitchMidi: number, currentNote: number): number {
    let bestNote = -1;
    let bestDistance = Infinity;
    let isCurrentHeld = false;
    for (let i = 0; i < this.heldCount; i++) {
      const heldKey = this.heldKeys[i] as number;
      if (heldKey === currentNote) isCurrentHeld = true;
      const distance = Math.abs(pitchMidi - heldKey);
      if (distance < bestDistance || (distance === bestDistance && heldKey < bestNote)) {
        bestDistance = distance;
        bestNote = heldKey;
      }
    }
    if (isCurrentHeld && bestNote !== currentNote && Math.abs(pitchMidi - currentNote) <= bestDistance + HYSTERESIS)
      return currentNote;
    return bestNote;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const rangeIndex = Math.round(params.range[0] as number);
    if (rangeIndex !== this.rangeIndex) {
      this.rangeIndex = rangeIndex;
      this.detectors[rangeIndex]?.reset();
      this.targetNote = -1;
    }
    const detector = (this.detectors[rangeIndex] ?? this.detectors[1]) as Yin;
    const keyRoot = Math.round(params.key[0] as number);
    const scaleMask = SCALE_MASKS[Math.round(params.scale[0] as number)] ?? 0xfff;
    const fromNotes = Math.round(params.source[0] as number) === 1;
    const humanize = params.humanize[0] as number;
    const vibratoDepthCents = params.vibratoDepth[0] as number;
    const vibratoStep = (params.vibratoRate[0] as number) / this.sampleRate;
    const keepsFormants = (params.formant[0] as number) > 0.5;
    if (!keepsFormants && this.isGrainSequenceRunning) this.stopGrains();
    const leftLine = this.delayLines[0] as DelayLine;
    const rightLine = this.delayLines[1] as DelayLine;
    const centreDelay = this.latency;
    for (let i = 0; i < frameCount; i++) {
      const inputLeft = inLeft[i] as number;
      const inputRight = inRight[i] as number;
      // 1. Pitch: feed the detector; a new estimate (and target note) every HOP_FRAMES frames.
      detector.push(0.5 * (inputLeft + inputRight));
      if (++this.framesSinceDetection >= HOP_FRAMES) {
        this.framesSinceDetection = 0;
        this.retarget(detector, keyRoot, scaleMask, fromNotes, humanize);
      }
      // 2. Correction: glide the correction (in cents) towards its goal, plus the added vibrato.
      const retuneSpeedMs = at(params.speed, i);
      if (retuneSpeedMs !== this.retuneSpeedMs) {
        this.retuneSpeedMs = retuneSpeedMs;
        this.glideCoefficient = retuneSpeedMs > 0 ? 1 - Math.exp(-1000 / (retuneSpeedMs * this.sampleRate)) : 1;
      }
      if (vibratoDepthCents > 0) {
        this.vibratoPhase += vibratoStep;
        if (this.vibratoPhase >= 1) this.vibratoPhase -= 1;
        const vibratoCents = vibratoDepthCents * this.vibratoLevel * Math.sin(TWO_PI * this.vibratoPhase);
        this.correctionCents += (this.goalCents + vibratoCents - this.correctionCents) * this.glideCoefficient;
      } else this.correctionCents += (this.goalCents - this.correctionCents) * this.glideCoefficient;
      // 3. Shifter: move the read head. A delay that grows by (1 - ratio) per frame plays `ratio` times as fast. The ratio only changes
      // while the correction glides (or retargets), so it is kept between those.
      if (this.correctionCents !== this.driftComputedForCents) {
        this.driftComputedForCents = this.correctionCents;
        this.headDriftPerFrame = 1 - pow2(this.correctionCents / 1200);
      }
      const driftPerFrame = this.headDriftPerFrame;
      const isNearRest = Math.abs(this.correctionCents) < REST_CENTS || this.isInTuneByCloserEstimate();
      if (isNearRest) {
        if (this.restFrames < this.restHoldFrames) this.restFrames++;
      } else this.restFrames = 0;
      if (this.spliceFrame < 0 && isNearRest) {
        // Nothing to correct: back to the centreDelay (where the output is the delayed input).
        const offset = this.readHead - centreDelay;
        if (offset > REST_RATE || offset < -REST_RATE) this.rest(offset);
        else this.readHead = centreDelay;
      } else {
        this.readHead += driftPerFrame;
        if (this.spliceFrame >= 0) this.incomingHead += driftPerFrame;
        else if (this.readHead < centreDelay - this.maxHeadOffset || this.readHead > centreDelay + this.maxHeadOffset)
          this.startSplice();
      }
      // 4. Output: read the shifted sound (crossfading to the incoming head during a splice), then mix with the dry.
      leftLine.write(inputLeft);
      rightLine.write(inputRight);
      let wetLeft = leftLine.readCubic(this.readHead);
      let wetRight = rightLine.readCubic(this.readHead);
      if (this.spliceFrame >= 0) {
        const progress = (this.spliceFrame + 1) / this.spliceFrames;
        const incomingShare = 0.5 - 0.5 * Math.cos(Math.PI * progress);
        wetLeft += incomingShare * (leftLine.readCubic(this.incomingHead) - wetLeft);
        wetRight += incomingShare * (rightLine.readCubic(this.incomingHead) - wetRight);
        if (++this.spliceFrame >= this.spliceFrames) {
          this.readHead = this.incomingHead;
          this.spliceFrame = -1;
        }
      }
      if (keepsFormants) {
        const grainShare = this.grains(leftLine, rightLine, 1 - this.headDriftPerFrame);
        if (grainShare > 0) {
          wetLeft += (this.grainLeft - wetLeft) * grainShare;
          wetRight += (this.grainRight - wetRight) * grainShare;
        }
      }
      const dryLeft = leftLine.read(centreDelay);
      const dryRight = rightLine.read(centreDelay);
      const mix = at(params.mix, i);
      outLeft[i] = dryLeft + mix * (wetLeft - dryLeft);
      outRight[i] = dryRight + mix * (wetRight - dryRight);
    }
    this.meter.tick(frameCount);
  }

  /** Grain mode's wet output for this frame (set by `grains`). */
  private grainLeft = 0;
  private grainRight = 0;

  /**
   * Keep formants. Pitch-synchronous overlap-add: a grain is two periods of the voice under a Hann window,
   * read at the voice's own speed (so its formants stay), and grains are laid down one new period apart
   * (period / ratio), each taken from the nearest point of the voice's own period grid, so a rise repeats some
   * periods and a fall skips some. Returns how much of the wet sound this frame the grains supply (0-1; it
   * ramps in and out with the first and last grain), with the sound in `grainL` / `grainR`.
   */
  private grains(leftLine: DelayLine, rightLine: DelayLine, speedRatio: number): number {
    const clock = this.grainClock++;
    if (this.isVoiced) {
      const periodFrames = this.periodFrames;
      if (!this.isGrainSequenceRunning) {
        this.isGrainSequenceRunning = true;
        this.nextHalfWidth = periodFrames;
        this.nextCentre = clock + periodFrames;
        // The first grain reads exactly the latency behind: no shift, no offset.
        this.lastCentre = this.nextCentre - this.latency;
      }
      // Spawn every grain that is due (one at a time at the usual rates).
      let spawned = 0;
      while (clock >= this.nextCentre - this.nextHalfWidth && spawned++ < 4) {
        let freeSlot = -1;
        for (let grain = 0; grain < MAX_GRAINS; grain++) {
          if (this.grainHalfWidth[grain] === 0) {
            freeSlot = grain;
            break;
          }
        }
        const grainCentre = this.nextCentre;
        const grainHalf = this.nextHalfWidth;
        if (freeSlot >= 0) {
          const periodsApart = Math.round((grainCentre - this.latency - this.lastCentre) / periodFrames);
          const sourceCentre = this.lastCentre + periodsApart * periodFrames;
          this.lastCentre = sourceCentre;
          this.grainDelay[freeSlot] = grainCentre - sourceCentre;
          this.grainOffset[freeSlot] = -grainHalf;
          this.grainHalfWidth[freeSlot] = grainHalf;
        }
        const spacing = periodFrames / (speedRatio > 0.5 ? speedRatio : 0.5);
        this.nextCentre = grainCentre + spacing;
        // Wider windows keep a fall of up to an octave from leaving gaps between grains.
        this.nextHalfWidth = Math.max(periodFrames, 0.75 * spacing);
      }
    } else if (this.isGrainSequenceRunning) this.isGrainSequenceRunning = false;
    let windowSum = 0;
    let leftSum = 0;
    let rightSum = 0;
    for (let grain = 0; grain < MAX_GRAINS; grain++) {
      const halfWidth = this.grainHalfWidth[grain] as number;
      if (halfWidth === 0) continue;
      const offsetFromCentre = this.grainOffset[grain] as number;
      const windowPosition = ((offsetFromCentre + halfWidth) / (2 * halfWidth)) * GRAIN_WINDOW_SIZE;
      const windowIndex = windowPosition | 0;
      const windowLow = GRAIN_WINDOW[windowIndex] as number;
      const windowHigh = GRAIN_WINDOW[windowIndex + 1] as number;
      const weight = windowLow + (windowHigh - windowLow) * (windowPosition - windowIndex);
      const delayFrames = this.grainDelay[grain] as number;
      windowSum += weight;
      leftSum += weight * leftLine.readCubic(delayFrames);
      rightSum += weight * rightLine.readCubic(delayFrames);
      if (offsetFromCentre + 1 >= halfWidth) this.grainHalfWidth[grain] = 0;
      else this.grainOffset[grain] = offsetFromCentre + 1;
    }
    if (windowSum < 1e-6) return 0;
    this.grainLeft = leftSum / windowSum;
    this.grainRight = rightSum / windowSum;
    const coverage = windowSum / (0.9 * speedRatio);
    return coverage > 1 ? 1 : coverage;
  }

  /** Lets every grain go (the sequence starts afresh at the next voiced note). */
  private stopGrains(): void {
    this.grainHalfWidth.fill(0);
    this.isGrainSequenceRunning = false;
  }

  /**
   * The head is `off` frames from its centre with nothing to correct: start a crossfade to a head nearer the centre
   * (a whole number of periods away while a pitch is known, straight to the centre once the voice has been unpitched
   * for a while), else drift the last stretch. Never allocates.
   */
  private rest(off: number): void {
    const period = this.periodFrames;
    // A glide through a note, or a moment of in-tune pitch, is not the end of a correction: only the slow drift until it has lasted.
    if (this.restFrames < this.restHoldFrames) {
      this.readHead += off > 0 ? -REST_RATE_SLOW : REST_RATE_SLOW;
      return;
    }
    if (this.unpitchedHops >= UNPITCHED_HOPS && (off > 0.5 || off < -0.5)) {
      this.incomingHead = this.latency;
      this.spliceFrame = 0;
      return;
    }
    const jumps = Math.round(off / period);
    if (jumps !== 0) {
      const next = this.readHead - jumps * period;
      // Never read closer than the cubic reader allows.
      if (next >= 2) {
        this.incomingHead = next;
        this.spliceFrame = 0;
        return;
      }
    }
    this.readHead += off > 0 ? -REST_RATE : REST_RATE;
  }

  /**
   * True when the correction being applied is a cent or more, but only because the plain estimate reads the voice off: the
   * closer estimate says it is in tune. The correction must also have caught up with its goal (so what it holds, less the
   * plain estimate's error, is what the closer estimate would have asked for): the moment a new note's estimate comes in
   * this stops, so a glide from one note to the next is never mistaken for a voice that has settled.
   */
  private isInTuneByCloserEstimate(): boolean {
    if (!(Math.abs(this.restGoalCents) < REST_CENTS)) return false;
    const correctionWithCloserEstimate = this.correctionCents - this.goalCents + this.restGoalCents;
    return Math.abs(correctionWithCloserEstimate) < REST_CENTS;
  }

  /** How far the read head is from its centre (frames; 0 = the output is the delayed input). For tests and meters. */
  get headOffset(): number {
    return this.readHead - this.latency;
  }

  /** Hands over to a head a whole number of periods back towards the centre. */
  private startSplice(): void {
    const period = this.periodFrames;
    const distance = Math.abs(this.readHead - this.latency) + this.maxHeadOffset;
    const jump = period * Math.max(1, Math.round(distance / period));
    this.incomingHead = this.readHead < this.latency ? this.readHead + jump : this.readHead - jump;
    // Never read closer than the cubic reader allows.
    if (this.incomingHead < 2) this.incomingHead += period * Math.ceil((2 - this.incomingHead) / period);
    this.spliceFrame = 0;
  }

  /** Stops pulling: no correction is wanted until a pitch with a note to pull to is found again. */
  private dropCorrection(): void {
    this.goalCents = 0;
    this.restGoalCents = 0;
    this.isVoiced = false;
    this.needsDriftRestart = true;
    this.vibratoLevel = 0;
  }

  /** A new pitch estimate: pick the note to pull to, and the correction to get there. */
  private retarget(detector: Yin, keyRoot: number, scaleMask: number, fromNotes: boolean, humanize: number): void {
    const pitchHz = detector.detect();
    const readings = this.meter.values;
    if (pitchHz <= 0 || detector.confidence < MIN_CONFIDENCE) {
      if (this.unpitchedHops < 1e6) this.unpitchedHops++;
      this.targetNote = -1;
      this.dropCorrection();
      readings.pitch = 0;
      readings.target = -1;
      readings.cents = this.correctionCents;
      return;
    }
    this.periodFrames = this.sampleRate / pitchHz;
    this.unpitchedHops = 0;
    const pitchMidi = 69 + 12 * Math.log2(pitchHz / 440);
    const previousNote = this.targetNote;
    this.targetNote = fromNotes
      ? this.nearestHeld(pitchMidi, this.targetNote)
      : nearestNote(pitchMidi, keyRoot, scaleMask, this.targetNote);
    if (this.targetNote < 0) {
      // Target = notes, and none is held: the voice is left as it is.
      this.dropCorrection();
      readings.pitch = pitchHz;
      readings.target = -1;
      readings.cents = this.correctionCents;
      return;
    }
    this.isVoiced = true;
    const shiftSemitones = this.targetNote - pitchMidi;
    const maxShiftCents = 100 * MAX_SHIFT_SEMITONES;
    this.goalCents = 100 * clamp(shiftSemitones, -MAX_SHIFT_SEMITONES, MAX_SHIFT_SEMITONES);
    if (humanize > 0) this.addNaturalDrift(pitchMidi, previousNote, humanize, maxShiftCents);
    this.restGoalCents = this.goalCents;
    if (Math.abs(this.goalCents) < REFINE_WITHIN_CENTS) {
      // Positive when the plain estimate reads the voice sharper than the closer one does (the goal moves the other way).
      this.restGoalCents += 1200 * Math.log2(pitchHz / detector.refinedFrequency());
    }
    this.vibratoLevel = this.targetNote === previousNote ? Math.min(1, this.vibratoLevel + this.vibratoFadeStep) : 0;
    readings.pitch = pitchHz;
    readings.target = this.targetNote;
    readings.cents = this.correctionCents;
  }

  /** Leaves a share of the slow wandering (the slow line against the note's own average) in the voice. */
  private addNaturalDrift(pitchMidi: number, previousNote: number, humanize: number, maxShiftCents: number): void {
    const pitchCents = pitchMidi * 100;
    if (this.targetNote !== previousNote || this.needsDriftRestart) {
      this.slowLineCents = pitchCents;
      this.averageLineCents = pitchCents;
      this.needsDriftRestart = false;
    } else {
      this.slowLineCents += (pitchCents - this.slowLineCents) * this.slowLineSmoothing;
      this.averageLineCents += (pitchCents - this.averageLineCents) * this.averageLineSmoothing;
    }
    const withDrift = this.goalCents + humanize * (this.slowLineCents - this.averageLineCents);
    this.goalCents = clamp(withDrift, -maxShiftCents, maxShiftCents);
  }
}
