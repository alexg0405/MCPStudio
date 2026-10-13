// Runs on the audio thread. Rules: no DOM, no fetch, no npm packages, no allocation inside process().
import { at, EffectKernel, registerKernel, type ParamBlock } from '@agstudio/sdk/worklet';
import { ID, params } from './params';

/**
 * Sample-and-hold downsampling plus quantization to a reduced bit depth. Effects get the insert's
 * stereo signal in `input` and write the same number of frames to `output`.
 */
class Bitcrusher extends EffectKernel<typeof params> {
  // State is allocated once, in the class body (keeps the object shape stable for the JIT).
  private readonly held = new Float32Array(2);
  private counter = 0;

  override reset(): void {
    this.held.fill(0);
    this.counter = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<typeof params>): void {
    // Int params arrive as one value per block (k-rate); floats can change every frame (use at()).
    const bits = p.bits[0] as number;
    const hold = p.downsample[0] as number;
    // Quantization steps per unit of amplitude (mid-tread, so silence stays silent).
    const steps = Math.pow(2, bits - 1);
    const channels = output.length < 2 ? output.length : 2;
    for (let i = 0; i < n; i++) {
      if (this.counter === 0) {
        for (let c = 0; c < channels; c++) {
          const x = (input[c] as Float32Array)[i] as number;
          this.held[c] = Math.round(x * steps) / steps;
        }
      }
      this.counter = this.counter + 1 >= hold ? 0 : this.counter + 1;
      const mix = at(p.mix, i);
      for (let c = 0; c < channels; c++) {
        const dry = (input[c] as Float32Array)[i] as number;
        const wet = this.held[c] as number;
        (output[c] as Float32Array)[i] = mix >= 1 ? wet : dry + mix * (wet - dry);
      }
    }
  }
}

registerKernel(ID, params, Bitcrusher);
