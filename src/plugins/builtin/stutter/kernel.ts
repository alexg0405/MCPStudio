import { at, EffectKernel, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import { REPEAT_BEATS, TRANCE, type stutterParams } from './params';

type Params = typeof stutterParams;

const GATE_QUARTER = 1;
const GATE_EIGHTH = 2;
const GATE_SIXTEENTH = 3;
const GATE_OFFBEAT = 4;
const GATE_TRANCE = 5;
const GATE_DOTTED = 6;
const GATE_TRIPLET = 7;
const GATE_HALF = 8;
/** History kept for tape stops and for the part of a repeat slice that already went by. */
const HISTORY_SEC = 8;
/** The longest slice beat repeat holds (a 1/2 note at 60 BPM). */
const MAX_SLICE_SEC = 2;
/** Crossfades at loop points and when an effect lets go, seconds. */
const FADE_SEC = 0.003;

const fractionOf = (x: number) => x - Math.floor(x);

/** Whether a gate pattern is open at a song position (in beats). */
export function gateOpen(gatePattern: number, beat: number): boolean {
  switch (gatePattern) {
    case GATE_QUARTER:
      return fractionOf(beat) < 0.5;
    case GATE_EIGHTH:
      return fractionOf(beat * 2) < 0.5;
    case GATE_SIXTEENTH:
      return fractionOf(beat * 4) < 0.5;
    case GATE_OFFBEAT:
      return fractionOf(beat) >= 0.5;
    case GATE_TRANCE:
      return TRANCE[Math.floor(fractionOf(beat / 4) * 16)] === 1;
    case GATE_DOTTED:
      return fractionOf(beat / 0.75) < 0.5;
    case GATE_TRIPLET:
      return fractionOf(beat * 3) < 0.5;
    case GATE_HALF:
      return fractionOf(beat / 2) < 0.5;
    default:
      return true;
  }
}

/**
 * Stutter: performance effects locked to the song position (`this.transport`), active only while
 * the song plays (stopped, the audio passes untouched).
 * - Gate: a smoothed on/off pattern (straight, off-beat, trance, dotted, triplet, half-time).
 * - Beat repeat: the slice of the chosen length that starts at the current grid line is captured
 *   (the part already played comes from the history) and looped while Repeat stays on, with short
 *   crossfades at the loop point and when it lets go.
 * - Tape stop: the output slows down to a halt over Stop time (reading the history at a falling
 *   speed), then stays silent until it is switched off.
 */
export class StutterKernel extends EffectKernel<Params> {
  private readonly historySize: number;
  private readonly historyMask: number;
  private readonly history: Float32Array[];
  private readonly repeatSlice: Float32Array[];
  private readonly fadeFrames = Math.max(1, Math.round(FADE_SEC * this.sampleRate));
  private framesWritten = 0;
  private gateGain = 1;
  // Beat repeat.
  private isRepeating = false;
  private repeatChoice = 0;
  private sliceLength = 0;
  private slicePosition = 0;
  private passNumber = 0;
  /** Frames left of the crossfade back to the live sound after a repeat or stop ends. */
  private releaseFramesLeft = 0;
  // Tape stop.
  private isStopping = false;
  private stopReadPosition = 0;
  private stopElapsedFrames = 0;
  private stopLengthFrames = 1;
  private wasStopOn = false;

  constructor(host: KernelHost) {
    super(host);
    // The history is a ring: a power of two long, so positions wrap with a mask.
    let historyFrames = 1;
    while (historyFrames < HISTORY_SEC * this.sampleRate) historyFrames <<= 1;
    this.historySize = historyFrames;
    this.historyMask = historyFrames - 1;
    this.history = [new Float32Array(historyFrames), new Float32Array(historyFrames)];
    // A slice holds the longest repeat plus the frames that follow it, for the crossfade at each loop point.
    const sliceFrames = Math.ceil(MAX_SLICE_SEC * this.sampleRate) + 2 * this.fadeFrames;
    this.repeatSlice = [new Float32Array(sliceFrames), new Float32Array(sliceFrames)];
  }

  override reset(): void {
    for (const historyChannel of this.history) historyChannel.fill(0);
    this.idle();
    this.gateGain = 1;
  }

  override transportChanged(): void {
    // A jump, a loop or a stop: captured slices and stops no longer belong where the song is.
    this.idle();
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const transport = this.transport;
    const historyLeft = this.history[0] as Float32Array;
    const historyRight = this.history[1] as Float32Array;
    if (!transport.playing) {
      // Stopped: untouched (the history keeps recording for the next start).
      for (let i = 0; i < frameCount; i++) {
        const leftSample = inLeft[i] as number;
        const rightSample = inRight[i] as number;
        historyLeft[this.framesWritten & this.historyMask] = leftSample;
        historyRight[this.framesWritten & this.historyMask] = rightSample;
        this.framesWritten++;
        outLeft[i] = leftSample;
        outRight[i] = rightSample;
      }
      this.gateGain = 1;
      this.idle();
      return;
    }
    const gatePattern = Math.round(params.gate[0] as number);
    const repeatChoice = Math.round(params.repeat[0] as number);
    const isStopOn = (params.stop[0] as number) >= 0.5;
    const framesPerBeat = (60 / transport.bpm) * this.sampleRate;
    if (isStopOn && !this.wasStopOn) this.startStop(at(params.stopTime, 0) * framesPerBeat);
    if (!isStopOn && this.wasStopOn && this.isStopping) {
      this.isStopping = false;
      this.releaseFramesLeft = this.fadeFrames;
    }
    this.wasStopOn = isStopOn;
    if (repeatChoice !== this.repeatChoice) {
      if (this.isRepeating) this.releaseFramesLeft = this.fadeFrames;
      this.isRepeating = false;
      this.repeatChoice = repeatChoice;
    }
    const sliceLeft = this.repeatSlice[0] as Float32Array;
    const sliceRight = this.repeatSlice[1] as Float32Array;
    for (let i = 0; i < frameCount; i++) {
      const beat = transport.beatAt(i);
      const inputLeft = inLeft[i] as number;
      const inputRight = inRight[i] as number;
      let shapedLeft = inputLeft;
      let shapedRight = inputRight;
      // Beat repeat.
      if (repeatChoice > 0 && !this.isRepeating)
        this.startRepeat(beat, (REPEAT_BEATS[repeatChoice] ?? 0) * framesPerBeat);
      if (this.isRepeating) {
        const sliceIndex = this.slicePosition;
        const sliceLen = this.sliceLength;
        if (this.passNumber === 0) {
          sliceLeft[sliceIndex] = inputLeft;
          sliceRight[sliceIndex] = inputRight;
        } else {
          // Store what follows the slice once, for the crossfade at each loop point.
          if (this.passNumber === 1 && sliceIndex < this.fadeFrames) {
            sliceLeft[sliceLen + sliceIndex] = inputLeft;
            sliceRight[sliceLen + sliceIndex] = inputRight;
          }
          shapedLeft = sliceLeft[sliceIndex] as number;
          shapedRight = sliceRight[sliceIndex] as number;
          if (sliceIndex < this.fadeFrames) {
            const fadeProgress = sliceIndex / this.fadeFrames;
            shapedLeft = (sliceLeft[sliceLen + sliceIndex] as number) * (1 - fadeProgress) + shapedLeft * fadeProgress;
            shapedRight =
              (sliceRight[sliceLen + sliceIndex] as number) * (1 - fadeProgress) + shapedRight * fadeProgress;
          }
        }
        if (++this.slicePosition >= sliceLen) {
          this.slicePosition = 0;
          this.passNumber++;
        }
      }
      historyLeft[this.framesWritten & this.historyMask] = shapedLeft;
      historyRight[this.framesWritten & this.historyMask] = shapedRight;
      this.framesWritten++;
      // Tape stop.
      if (this.isStopping) {
        const playbackSpeed =
          this.stopElapsedFrames < this.stopLengthFrames ? 1 - this.stopElapsedFrames / this.stopLengthFrames : 0;
        this.stopElapsedFrames++;
        if (playbackSpeed > 0) {
          const stopFade = playbackSpeed < 0.125 ? playbackSpeed * 8 : 1;
          shapedLeft = this.readHistory(historyLeft, this.stopReadPosition) * stopFade;
          shapedRight = this.readHistory(historyRight, this.stopReadPosition) * stopFade;
          this.stopReadPosition += playbackSpeed;
        } else {
          shapedLeft = 0;
          shapedRight = 0;
        }
      } else if (this.releaseFramesLeft > 0) {
        // Back to the live sound after a repeat or a stop: a short fade in.
        const fadeInGain = 1 - this.releaseFramesLeft / this.fadeFrames;
        shapedLeft *= fadeInGain;
        shapedRight *= fadeInGain;
        this.releaseFramesLeft--;
      }
      // Gate.
      const gateTarget = gateOpen(gatePattern, beat) ? 1 : 1 - at(params.depth, i);
      const gateTauFrames = (at(params.smooth, i) / 3000) * this.sampleRate;
      this.gateGain += (gateTarget - this.gateGain) * (gateTauFrames > 1 ? 1 / gateTauFrames : 1);
      const mix = at(params.mix, i);
      const gateAtFrame = this.gateGain;
      outLeft[i] = inputLeft + mix * (shapedLeft * gateAtFrame - inputLeft);
      outRight[i] = inputRight + mix * (shapedRight * gateAtFrame - inputRight);
    }
  }

  /** Starts looping the slice whose grid line is at or before `beat`. */
  private startRepeat(beat: number, lengthFrames: number): void {
    const sliceLen = Math.max(
      this.fadeFrames + 1,
      Math.min(Math.round(lengthFrames), (this.repeatSlice[0] as Float32Array).length - 2 * this.fadeFrames),
    );
    const beats = lengthFrames / ((60 / this.transport.bpm) * this.sampleRate);
    const framesIntoSlice =
      beats > 0 ? Math.round((beat - Math.floor(beat / beats + 1e-9) * beats) * (sliceLen / beats)) : 0;
    const framesPassed = Math.min(sliceLen - 1, Math.max(0, framesIntoSlice));
    // The part of the slice that already played comes from the history.
    for (let channel = 0; channel < 2; channel++) {
      const historyChannel = this.history[channel] as Float32Array;
      const sliceChannel = this.repeatSlice[channel] as Float32Array;
      for (let index = 0; index < framesPassed; index++)
        sliceChannel[index] = historyChannel[(this.framesWritten - framesPassed + index) & this.historyMask] as number;
    }
    this.sliceLength = sliceLen;
    this.slicePosition = framesPassed;
    this.passNumber = 0;
    this.isRepeating = true;
  }

  private startStop(lengthFrames: number): void {
    this.isStopping = true;
    this.stopLengthFrames = Math.max(1, lengthFrames);
    this.stopElapsedFrames = 0;
    // The read head starts at the newest sample (written - 1) and falls behind.
    this.stopReadPosition = this.framesWritten - 1;
  }

  private readHistory(history: Float32Array, position: number): number {
    const wholeFrames = Math.floor(position);
    const fraction = position - wholeFrames;
    const before = history[wholeFrames & this.historyMask] as number;
    const after = history[(wholeFrames + 1) & this.historyMask] as number;
    return before + (after - before) * fraction;
  }

  private idle(): void {
    this.isRepeating = false;
    this.repeatChoice = 0;
    this.isStopping = false;
    this.wasStopOn = false;
    this.releaseFramesLeft = 0;
  }
}
