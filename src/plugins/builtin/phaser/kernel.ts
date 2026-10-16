import { at, EffectKernel, flush, PhaseClock, type ParamBlock } from '@agstudio/sdk/worklet';
import { STAGES, SYNC_BEATS, type phaserParams } from './params';

type P = typeof phaserParams;

const MAX_STAGES = 12;
/** The LFO and the allpass coefficient are computed every CONTROL frames and ramped in between. */
const CONTROL = 16;
const STAGE_COUNTS = STAGES.map(Number);

/**
 * Coefficient of a first-order allpass `(a + z⁻¹) / (1 + a·z⁻¹)` whose phase is −90° at `freq`.
 */
export function allpassCoefficient(freq: number, sampleRate: number): number {
  const t = Math.tan((Math.PI * Math.min(freq, 0.49 * sampleRate)) / sampleRate);
  return (t - 1) / (t + 1);
}

/**
 * Stereo phaser: a chain of 4–12 first-order allpasses whose frequency a sine LFO sweeps
 * (exponentially) between Low and High, with feedback around the chain, mixed with the dry signal
 * (50 % gives the deepest notches: N stages make N / 2 notches). The right side's sweep is offset
 * by up to half a cycle (`width`). Free-running or synced to the song with PhaseClock.
 */
export class PhaserKernel extends EffectKernel<P> {
  /** Allpass states [side · MAX_STAGES + stage]: previous input and output. */
  private readonly x1 = new Float64Array(2 * MAX_STAGES);
  private readonly y1 = new Float64Array(2 * MAX_STAGES);
  private readonly clock = new PhaseClock(this.sampleRate);
  private readonly coef = new Float64Array(2);
  private readonly step = new Float64Array(2);
  private readonly fb = new Float64Array(2);
  private countdown = 0;
  private primed = false;

  override reset(): void {
    this.x1.fill(0);
    this.y1.fill(0);
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
    const stages = STAGE_COUNTS[Math.round(p.stages[0] as number)] ?? 4;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.target(i, sync, at(p.rate, i), at(p.depth, i), at(p.low, i), at(p.high, i), at(p.width, i));
      }
      this.countdown--;
      const feedback = at(p.feedback, i);
      const mix = at(p.mix, i);
      for (let c = 0; c < 2; c++) {
        const x = ((input[c] ?? input[0]) as Float32Array)[i] as number;
        const a = (this.coef[c] as number) + (this.step[c] as number);
        this.coef[c] = a;
        let v = x + feedback * (this.fb[c] as number);
        const o = c * MAX_STAGES;
        for (let s = 0; s < stages; s++) {
          const k = o + s;
          const y = a * v + (this.x1[k] as number) - a * (this.y1[k] as number);
          this.x1[k] = v;
          this.y1[k] = y;
          v = y;
        }
        this.fb[c] = v;
        (output[c] as Float32Array)[i] = (1 - mix) * x + mix * v;
      }
    }
    // Denormals and NaN are flushed once per block: states only fall that far over hundreds of frames.
    for (let k = 0; k < 2 * MAX_STAGES; k++) {
      this.x1[k] = flush(this.x1[k] as number);
      this.y1[k] = flush(this.y1[k] as number);
    }
    this.fb[0] = flush(this.fb[0] as number);
    this.fb[1] = flush(this.fb[1] as number);
  }

  private target(i: number, sync: number, rate: number, depth: number, low: number, high: number, width: number) {
    const phase = this.clock.next(this.transport, i, rate, sync, CONTROL);
    const lo = Math.min(low, high);
    const hi = Math.max(low, high);
    const center = Math.sqrt(lo * hi);
    const span = 0.5 * Math.log2(hi / lo) * depth;
    for (let c = 0; c < 2; c++) {
      const lfo = Math.sin(2 * Math.PI * (phase + (c === 1 ? 0.5 * width : 0)));
      const goal = allpassCoefficient(center * Math.pow(2, span * lfo), this.sampleRate);
      if (!this.primed) this.coef[c] = goal;
      this.step[c] = (goal - (this.coef[c] as number)) / CONTROL;
    }
    this.primed = true;
  }
}
