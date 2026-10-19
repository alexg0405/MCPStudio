import { at, clamp, DelayLine, EffectKernel, flush, PhaseClock, type ParamBlock } from '@agstudio/sdk/worklet';
import { SYNC_BEATS, type flangerParams } from './params';

type Params = typeof flangerParams;

/** How far the sweep travels above the base delay at 100 % depth, ms. */
const SWEEP_MS = 6;
/** The LFO and the delay targets are computed every CONTROL frames and ramped in between. */
const CONTROL_FRAMES = 16;
/** Fastest the delay may move, frames per frame (a jumping synced LFO glides instead of clicking). */
const MAX_DELAY_STEP = 0.25;

/** A triangle in 0–1 at a phase in cycles. */
function triangle(phase: number): number {
  const phaseInCycle = phase - Math.floor(phase);
  return phaseInCycle < 0.5 ? 2 * phaseInCycle : 2 - 2 * phaseInCycle;
}

/**
 * Stereo flanger: each side reads a delay line at a delay swept by a triangle LFO between `delay`
 * and `delay` + depth · 6 ms, with feedback (positive: metallic, negative: hollow), mixed with the
 * dry signal (50 % gives the deepest notches). The right side's sweep is offset by up to half a
 * cycle (`width`). Free-running or synced to the song with PhaseClock.
 */
export class FlangerKernel extends EffectKernel<Params> {
  private readonly delayLines = [new DelayLine(this.frames(20)), new DelayLine(this.frames(20))];
  private readonly clock = new PhaseClock(this.sampleRate);
  private readonly sideDelays = new Float64Array(2);
  private readonly sideDelaySteps = new Float64Array(2);
  private readonly feedbackState = new Float64Array(2);
  private countdown = 0;
  private isPrimed = false;

  override reset(): void {
    for (const delayLine of this.delayLines) delayLine.clear();
    this.feedbackState.fill(0);
    this.clock.reset();
    this.countdown = 0;
    this.isPrimed = false;
  }

  override transportChanged(): void {
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const syncBeats = SYNC_BEATS[Math.round(params.sync[0] as number)] ?? 0;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.target(i, syncBeats, at(params.rate, i), at(params.depth, i), at(params.delay, i), at(params.width, i));
      }
      this.countdown--;
      const feedback = at(params.feedback, i);
      const mix = at(params.mix, i);
      for (let channel = 0; channel < 2; channel++) {
        const dry = ((input[channel] ?? input[0]) as Float32Array)[i] as number;
        const delayLine = this.delayLines[channel] as DelayLine;
        const delayFrames = (this.sideDelays[channel] as number) + (this.sideDelaySteps[channel] as number);
        this.sideDelays[channel] = delayFrames;
        // Read before writing: the line holds the past, so `d` frames back is d + 1 here.
        const wet = delayLine.readCubic(delayFrames - 1);
        const feedbackSample = flush(wet);
        this.feedbackState[channel] = feedbackSample;
        delayLine.write(dry + feedback * feedbackSample);
        // Strong feedback resonates: give some of that level back so presets stay usable.
        const resonanceCompensation = 1 - 0.5 * (feedback < 0 ? -feedback : feedback);
        (output[channel] as Float32Array)[i] = (1 - mix) * dry + mix * resonanceCompensation * wet;
      }
    }
  }

  private target(frame: number, sync: number, rate: number, depth: number, delayMs: number, width: number): void {
    const phase = this.clock.next(this.transport, frame, rate, sync, CONTROL_FRAMES);
    const base = (delayMs * this.sampleRate) / 1000;
    const sweep = (depth * SWEEP_MS * this.sampleRate) / 1000;
    for (let c = 0; c < 2; c++) {
      const goal = Math.max(1, base + sweep * triangle(phase + (c === 1 ? 0.5 * width : 0)));
      if (!this.isPrimed) this.sideDelays[c] = goal;
      const step = (goal - (this.sideDelays[c] as number)) / CONTROL_FRAMES;
      this.sideDelaySteps[c] = clamp(step, -MAX_DELAY_STEP, MAX_DELAY_STEP);
    }
    this.isPrimed = true;
  }

  private frames(ms: number): number {
    return Math.ceil((ms * this.sampleRate) / 1000);
  }
}
