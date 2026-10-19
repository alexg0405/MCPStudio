import { at, clamp, DelayLine, EffectKernel, flush, PhaseClock, type ParamBlock } from '@agstudio/sdk/worklet';
import { SYNC_BEATS, type chorusParams } from './params';

type Params = typeof chorusParams;

const MAX_VOICES = 4;
/** Peak-to-peak drift of a voice at 100 % depth, ms. */
const SWING_MS = 5;
/** The LFO and delay targets are computed every CONTROL frames and ramped in between. */
const CONTROL_FRAMES = 16;
const TWO_PI = 2 * Math.PI;
/**
 * Fastest a voice's delay may change, in frames per frame (a pitch shift of up to 25 %): far above
 * what the LFO asks for, but a synced LFO that jumps with the song glides there instead of clicking.
 */
const MAX_DELAY_STEP = 0.25;

/**
 * Stereo chorus: up to four voices per side, each a copy of the input read from a delay line whose
 * delay drifts with a sine LFO (phases spread evenly across the voices, the right side's offset by
 * `width`). Free-running, or locked to the song position with Sync (`PhaseClock`), so a synced
 * chorus moves the same way on every playback.
 */
export class ChorusKernel extends EffectKernel<Params> {
  private readonly delayLines = [new DelayLine(this.frames(60)), new DelayLine(this.frames(60))];
  private readonly clock = new PhaseClock(this.sampleRate);
  /** Current and per-frame step of each voice's delay (frames), [side · MAX_VOICES + voice]. */
  private readonly voiceDelays = new Float64Array(2 * MAX_VOICES);
  private readonly voiceDelaySteps = new Float64Array(2 * MAX_VOICES);
  private readonly feedbackState = new Float64Array(2);
  private countdown = 0;
  /** Voices whose delays are running (new ones start at their target instead of sweeping to it). */
  private runningVoices = 0;

  override reset(): void {
    for (const delayLine of this.delayLines) delayLine.clear();
    this.feedbackState.fill(0);
    this.clock.reset();
    this.countdown = 0;
    this.runningVoices = 0;
  }

  override transportChanged(): void {
    // A jump in the song moves a synced LFO: glide to it over the next control step.
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const voices = Math.max(1, Math.min(MAX_VOICES, Math.round(params.voices[0] as number)));
    const syncBeats = SYNC_BEATS[Math.round(params.sync[0] as number)] ?? 0;
    const gain = 1 / Math.sqrt(voices);
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.target(
          i,
          voices,
          syncBeats,
          at(params.rate, i),
          at(params.depth, i),
          at(params.delay, i),
          at(params.width, i),
        );
      }
      this.countdown--;
      const feedback = at(params.feedback, i);
      const mix = at(params.mix, i);
      for (let channel = 0; channel < 2; channel++) {
        const dry = ((input[channel] ?? input[0]) as Float32Array)[i] as number;
        const delayLine = this.delayLines[channel] as DelayLine;
        delayLine.write(dry + feedback * (this.feedbackState[channel] as number));
        let wet = 0;
        for (let voice = 0; voice < voices; voice++) {
          const slot = channel * MAX_VOICES + voice;
          const delayFrames = (this.voiceDelays[slot] as number) + (this.voiceDelaySteps[slot] as number);
          this.voiceDelays[slot] = delayFrames;
          wet += delayLine.readCubic(delayFrames);
        }
        wet *= gain;
        this.feedbackState[channel] = flush(wet);
        (output[channel] as Float32Array)[i] = (1 - mix) * dry + mix * wet;
      }
    }
  }

  /** New delay targets for every voice, reached by a linear ramp over the next CONTROL frames. */
  private target(
    frame: number,
    voices: number,
    sync: number,
    rate: number,
    depth: number,
    delayMs: number,
    width: number,
  ) {
    const phase = this.clock.next(this.transport, frame, rate, sync, CONTROL_FRAMES);
    const base = (delayMs * this.sampleRate) / 1000;
    const swing = (depth * SWING_MS * this.sampleRate) / 1000;
    for (let c = 0; c < 2; c++) {
      for (let v = 0; v < voices; v++) {
        // Voices spread evenly around the cycle; the right side is offset by up to half a cycle.
        const offset = v / voices + (c === 1 ? 0.5 * width : 0);
        const goal = base + swing * (0.5 + 0.5 * Math.sin(TWO_PI * (phase + offset)));
        const k = c * MAX_VOICES + v;
        if (v >= this.runningVoices) this.voiceDelays[k] = goal;
        const step = (goal - (this.voiceDelays[k] as number)) / CONTROL_FRAMES;
        this.voiceDelaySteps[k] = clamp(step, -MAX_DELAY_STEP, MAX_DELAY_STEP);
      }
    }
    this.runningVoices = voices;
  }

  private frames(ms: number): number {
    return Math.ceil((ms * this.sampleRate) / 1000);
  }
}
