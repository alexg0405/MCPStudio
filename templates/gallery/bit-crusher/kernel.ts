// Pure DSP, no AudioWorklet globals, so it can be tested in Node. Rules: no allocation inside process().
import { at, EffectKernel, type ParamBlock } from '@agstudio/sdk/worklet';
import type { params } from './params';

/**
 * Sample-and-hold at a lower sample rate plus rounding to fewer bits. The hold uses a phase that counts how far the lower
 * rate has come, so any rate works (not only whole divisions of the real one).
 */
export class BitCrusherKernel extends EffectKernel<typeof params> {
  private readonly held = new Float32Array(2);
  /** 0 to 1: how far we are into the current held sample. A new sample is taken when it wraps. */
  private phase = 1;

  override reset(): void {
    this.held.fill(0);
    this.phase = 1;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<typeof params>): void {
    const channels = Math.min(output.length, 2);
    // Int params arrive once per block; steps are the rounding levels per unit of amplitude (silence stays silent).
    const steps = Math.pow(2, (p.bits[0] as number) - 1);
    for (let i = 0; i < n; i++) {
      this.phase += Math.min(1, at(p.rate, i) / this.sampleRate);
      if (this.phase >= 1) {
        this.phase -= 1;
        for (let c = 0; c < channels; c++) {
          const sample = (input[c] as Float32Array)[i] as number;
          this.held[c] = Math.round(sample * steps) / steps;
        }
      }
      const mix = at(p.mix, i);
      for (let c = 0; c < channels; c++) {
        const dry = (input[c] as Float32Array)[i] as number;
        const crushed = this.held[c] as number;
        (output[c] as Float32Array)[i] = dry + mix * (crushed - dry);
      }
    }
  }
}
