import { at, DelayLine, EffectKernel, flush, PhaseClock, type ParamBlock } from '@agstudio/sdk/worklet';
import { SYNC_BEATS, type chorusParams } from './params';

type P = typeof chorusParams;

const MAX_VOICES = 4;
/** Peak-to-peak drift of a voice at 100 % depth, ms. */
const SWING_MS = 5;
/** The LFO and delay targets are computed every CONTROL frames and ramped in between. */
const CONTROL = 16;
const TWO_PI = 2 * Math.PI;
/**
 * Fastest a voice's delay may change, in frames per frame (a pitch shift of up to 25 %): far above
 * what the LFO asks for, but a synced LFO that jumps with the song glides there instead of clicking.
 */
const MAX_STEP = 0.25;

/**
 * Stereo chorus: up to four voices per side, each a copy of the input read from a delay line whose
 * delay drifts with a sine LFO (phases spread evenly across the voices, the right side's offset by
 * `width`). Free-running, or locked to the song position with Sync (`PhaseClock`), so a synced
 * chorus moves the same way on every playback.
 */
export class ChorusKernel extends EffectKernel<P> {
  private readonly lines = [new DelayLine(this.frames(60)), new DelayLine(this.frames(60))];
  private readonly clock = new PhaseClock(this.sampleRate);
  /** Current and per-frame step of each voice's delay (frames), [side · MAX_VOICES + voice]. */
  private readonly delays = new Float64Array(2 * MAX_VOICES);
  private readonly steps = new Float64Array(2 * MAX_VOICES);
  private readonly fb = new Float64Array(2);
  private countdown = 0;
  /** Voices whose delays are running (new ones start at their target instead of sweeping to it). */
  private running = 0;

  override reset(): void {
    for (const l of this.lines) l.clear();
    this.fb.fill(0);
    this.clock.reset();
    this.countdown = 0;
    this.running = 0;
  }

  override transportChanged(): void {
    // A jump in the song moves a synced LFO: glide to it over the next control step.
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const voices = Math.max(1, Math.min(MAX_VOICES, Math.round(p.voices[0] as number)));
    const sync = SYNC_BEATS[Math.round(p.sync[0] as number)] ?? 0;
    const gain = 1 / Math.sqrt(voices);
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.target(i, voices, sync, at(p.rate, i), at(p.depth, i), at(p.delay, i), at(p.width, i));
      }
      this.countdown--;
      const feedback = at(p.feedback, i);
      const mix = at(p.mix, i);
      for (let c = 0; c < 2; c++) {
        const x = ((input[c] ?? input[0]) as Float32Array)[i] as number;
        const line = this.lines[c] as DelayLine;
        line.write(x + feedback * (this.fb[c] as number));
        let wet = 0;
        for (let v = 0; v < voices; v++) {
          const k = c * MAX_VOICES + v;
          const d = (this.delays[k] as number) + (this.steps[k] as number);
          this.delays[k] = d;
          wet += line.readCubic(d);
        }
        wet *= gain;
        this.fb[c] = flush(wet);
        (output[c] as Float32Array)[i] = (1 - mix) * x + mix * wet;
      }
    }
  }

  /** New delay targets for every voice, reached by a linear ramp over the next CONTROL frames. */
  private target(i: number, voices: number, sync: number, rate: number, depth: number, delayMs: number, width: number) {
    const phase = this.clock.next(this.transport, i, rate, sync, CONTROL);
    const base = (delayMs * this.sampleRate) / 1000;
    const swing = (depth * SWING_MS * this.sampleRate) / 1000;
    for (let c = 0; c < 2; c++) {
      for (let v = 0; v < voices; v++) {
        // Voices spread evenly around the cycle; the right side is offset by up to half a cycle.
        const offset = v / voices + (c === 1 ? 0.5 * width : 0);
        const goal = base + swing * (0.5 + 0.5 * Math.sin(TWO_PI * (phase + offset)));
        const k = c * MAX_VOICES + v;
        if (v >= this.running) this.delays[k] = goal;
        const step = (goal - (this.delays[k] as number)) / CONTROL;
        this.steps[k] = step > MAX_STEP ? MAX_STEP : step < -MAX_STEP ? -MAX_STEP : step;
      }
    }
    this.running = voices;
  }

  private frames(ms: number): number {
    return Math.ceil((ms * this.sampleRate) / 1000);
  }
}
