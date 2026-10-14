import { at, DelayLine, EffectKernel, flush, PhaseClock, type ParamBlock } from '@agstudio/sdk/worklet';
import { SYNC_BEATS, type flangerParams } from './params';

type P = typeof flangerParams;

/** How far the sweep travels above the base delay at 100 % depth, ms. */
const SWEEP_MS = 6;
/** The LFO and the delay targets are computed every CONTROL frames and ramped in between. */
const CONTROL = 16;
/** Fastest the delay may move, frames per frame (a jumping synced LFO glides instead of clicking). */
const MAX_STEP = 0.25;

/** A triangle in 0–1 at a phase in cycles. */
function triangle(phase: number): number {
  const t = phase - Math.floor(phase);
  return t < 0.5 ? 2 * t : 2 - 2 * t;
}

/**
 * Stereo flanger: each side reads a delay line at a delay swept by a triangle LFO between `delay`
 * and `delay` + depth · 6 ms, with feedback (positive: metallic, negative: hollow), mixed with the
 * dry signal (50 % gives the deepest notches). The right side's sweep is offset by up to half a
 * cycle (`width`). Free-running or synced to the song with PhaseClock.
 */
export class FlangerKernel extends EffectKernel<P> {
  private readonly lines = [new DelayLine(this.frames(20)), new DelayLine(this.frames(20))];
  private readonly clock = new PhaseClock(this.sampleRate);
  private readonly delays = new Float64Array(2);
  private readonly steps = new Float64Array(2);
  private readonly fb = new Float64Array(2);
  private countdown = 0;
  private primed = false;

  override reset(): void {
    for (const l of this.lines) l.clear();
    this.fb.fill(0);
    this.clock.reset();
    this.countdown = 0;
    this.primed = false;
  }

  override transportChanged(): void {
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const sync = SYNC_BEATS[Math.round(p.sync[0] as number)] ?? 0;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.target(i, sync, at(p.rate, i), at(p.depth, i), at(p.delay, i), at(p.width, i));
      }
      this.countdown--;
      const feedback = at(p.feedback, i);
      const mix = at(p.mix, i);
      for (let c = 0; c < 2; c++) {
        const x = ((input[c] ?? input[0]) as Float32Array)[i] as number;
        const line = this.lines[c] as DelayLine;
        const d = (this.delays[c] as number) + (this.steps[c] as number);
        this.delays[c] = d;
        // Read before writing: the line holds the past, so `d` frames back is d + 1 here.
        const wet = line.readCubic(d - 1);
        const fb = flush(wet);
        this.fb[c] = fb;
        line.write(x + feedback * fb);
        // Strong feedback resonates: give some of that level back so presets stay usable.
        const comp = 1 - 0.5 * (feedback < 0 ? -feedback : feedback);
        (output[c] as Float32Array)[i] = (1 - mix) * x + mix * comp * wet;
      }
    }
  }

  private target(i: number, sync: number, rate: number, depth: number, delayMs: number, width: number): void {
    const phase = this.clock.next(this.transport, i, rate, sync, CONTROL);
    const base = (delayMs * this.sampleRate) / 1000;
    const sweep = (depth * SWEEP_MS * this.sampleRate) / 1000;
    for (let c = 0; c < 2; c++) {
      const goal = Math.max(1, base + sweep * triangle(phase + (c === 1 ? 0.5 * width : 0)));
      if (!this.primed) this.delays[c] = goal;
      const step = (goal - (this.delays[c] as number)) / CONTROL;
      this.steps[c] = step > MAX_STEP ? MAX_STEP : step < -MAX_STEP ? -MAX_STEP : step;
    }
    this.primed = true;
  }

  private frames(ms: number): number {
    return Math.ceil((ms * this.sampleRate) / 1000);
  }
}
