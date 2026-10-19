import { at, EffectKernel, flush, PhaseClock, type ParamBlock } from '@agstudio/sdk/worklet';
import { STAGES, SYNC_BEATS, type phaserParams } from './params';

type Params = typeof phaserParams;

const MAX_STAGES = 12;
/** The LFO and the allpass coefficient are computed every CONTROL frames and ramped in between. */
const CONTROL_FRAMES = 16;
const STAGE_COUNTS = STAGES.map(Number);

/**
 * Coefficient of a first-order allpass `(a + z⁻¹) / (1 + a·z⁻¹)` whose phase is −90° at `freq`.
 */
export function allpassCoefficient(frequencyHz: number, sampleRate: number): number {
  const tangent = Math.tan((Math.PI * Math.min(frequencyHz, 0.49 * sampleRate)) / sampleRate);
  return (tangent - 1) / (tangent + 1);
}

/**
 * Stereo phaser: a chain of 4–12 first-order allpasses whose frequency a sine LFO sweeps
 * (exponentially) between Low and High, with feedback around the chain, mixed with the dry signal
 * (50 % gives the deepest notches: N stages make N / 2 notches). The right side's sweep is offset
 * by up to half a cycle (`width`). Free-running or synced to the song with PhaseClock.
 */
export class PhaserKernel extends EffectKernel<Params> {
  /** Allpass states [side · MAX_STAGES + stage]: previous input and output. */
  private readonly previousInput = new Float64Array(2 * MAX_STAGES);
  private readonly previousOutput = new Float64Array(2 * MAX_STAGES);
  private readonly clock = new PhaseClock(this.sampleRate);
  private readonly coefficients = new Float64Array(2);
  private readonly coefficientSteps = new Float64Array(2);
  private readonly feedbackState = new Float64Array(2);
  private countdown = 0;
  private isPrimed = false;

  override reset(): void {
    this.previousInput.fill(0);
    this.previousOutput.fill(0);
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
    const stages = STAGE_COUNTS[Math.round(params.stages[0] as number)] ?? 4;
    for (let i = 0; i < frameCount; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL_FRAMES;
        this.target(
          i,
          syncBeats,
          at(params.rate, i),
          at(params.depth, i),
          at(params.low, i),
          at(params.high, i),
          at(params.width, i),
        );
      }
      this.countdown--;
      const feedback = at(params.feedback, i);
      const mix = at(params.mix, i);
      for (let channel = 0; channel < 2; channel++) {
        const dry = ((input[channel] ?? input[0]) as Float32Array)[i] as number;
        const coefficient = (this.coefficients[channel] as number) + (this.coefficientSteps[channel] as number);
        this.coefficients[channel] = coefficient;
        let signal = dry + feedback * (this.feedbackState[channel] as number);
        const sideOffset = channel * MAX_STAGES;
        for (let stage = 0; stage < stages; stage++) {
          const slot = sideOffset + stage;
          const stageOutput =
            coefficient * signal +
            (this.previousInput[slot] as number) -
            coefficient * (this.previousOutput[slot] as number);
          this.previousInput[slot] = signal;
          this.previousOutput[slot] = flush(stageOutput);
          signal = stageOutput;
        }
        this.feedbackState[channel] = flush(signal);
        (output[channel] as Float32Array)[i] = (1 - mix) * dry + mix * signal;
      }
    }
  }

  private target(frame: number, sync: number, rate: number, depth: number, low: number, high: number, width: number) {
    const phase = this.clock.next(this.transport, frame, rate, sync, CONTROL_FRAMES);
    const lowHz = Math.min(low, high);
    const highHz = Math.max(low, high);
    const centreHz = Math.sqrt(lowHz * highHz);
    const octaveSpan = 0.5 * Math.log2(highHz / lowHz) * depth;
    for (let c = 0; c < 2; c++) {
      const lfoValue = Math.sin(2 * Math.PI * (phase + (c === 1 ? 0.5 * width : 0)));
      const goal = allpassCoefficient(centreHz * Math.pow(2, octaveSpan * lfoValue), this.sampleRate);
      if (!this.isPrimed) this.coefficients[c] = goal;
      this.coefficientSteps[c] = (goal - (this.coefficients[c] as number)) / CONTROL_FRAMES;
    }
    this.isPrimed = true;
  }
}
