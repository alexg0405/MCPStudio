// Runs on the audio thread. Rules: no DOM, no fetch, no npm packages, no allocation inside process().
import { at, dbToGain, EffectKernel, registerKernel, type ParamBlock } from '@agstudio/sdk/worklet';
import { ID, params } from './params';

class Saturator extends EffectKernel<typeof params> {
  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<typeof params>): void {
    for (let c = 0; c < output.length; c++) {
      const inp = input[c]!;
      const out = output[c]!;
      for (let i = 0; i < n; i++) {
        const drive = dbToGain(at(p.drive, i));
        const mix = at(p.mix, i);
        const dry = inp[i]!;
        const wet = Math.tanh(dry * drive) / Math.tanh(drive);
        out[i] = dry + mix * (wet - dry);
      }
    }
  }
}

registerKernel(ID, params, Saturator);
