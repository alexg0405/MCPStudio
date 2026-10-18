/** The effect kernel of a Faust plugin: one DSP instance that processes the insert's audio. */
import type { ParamSpecs } from '../params';
import { EffectKernel, type KernelHost, type ParamBlock } from '../worklet/kernel';
import { FAUST_BLOCK_FRAMES, FaustInstance } from './instance';
import { ParamSync } from './param-sync';
import type { FaustControl, FaustMeta } from './params';

/**
 * Copies `count` frames of the effect's input, starting at `offset`, into the DSP's input buffers.
 * A mono DSP hears both sides (their average); a stereo one hears each side.
 */
function loadInputs(dsp: FaustInstance, input: Float32Array[], offset: number, count: number): void {
  const inputChannels = dsp.inputs.length;
  for (let c = 0; c < inputChannels; c++) {
    const target = dsp.inputs[c] as Float32Array;
    if (inputChannels === 1 && input.length > 1) {
      const left = input[0] as Float32Array;
      const right = input[1] as Float32Array;
      for (let i = 0; i < count; i++) target[i] = 0.5 * ((left[offset + i] as number) + (right[offset + i] as number));
    } else {
      const source = (input[c] ?? input[0]) as Float32Array;
      for (let i = 0; i < count; i++) target[i] = source[offset + i] as number;
    }
  }
}

/** Copies `count` computed frames to the effect's output starting at `offset`; a mono DSP feeds every output channel. */
function storeOutputs(dsp: FaustInstance, output: Float32Array[], offset: number, count: number): void {
  const outputChannels = dsp.outputs.length;
  if (outputChannels === 0) return;
  for (let c = 0; c < output.length; c++) {
    const target = output[c] as Float32Array;
    const source = dsp.outputs[Math.min(c, outputChannels - 1)] as Float32Array;
    for (let i = 0; i < count; i++) target[offset + i] = source[i] as number;
  }
}

/** The kernel class for an effect DSP (a class per DSP, since the compiled module and controls are shared by its instances). */
export function faustEffectClass(
  module: WebAssembly.Module,
  meta: FaustMeta,
  controls: readonly FaustControl[],
): new (host: KernelHost) => EffectKernel<ParamSpecs> {
  return class FaustEffect extends EffectKernel<ParamSpecs> {
    private readonly dsp: FaustInstance;
    private readonly sync = new ParamSync(controls);

    constructor(host: KernelHost) {
      super(host);
      this.dsp = new FaustInstance(module, meta, host.sampleRate);
    }

    process(input: Float32Array[], output: Float32Array[], n: number, block: ParamBlock): void {
      if (this.sync.read(block)) this.sync.apply(this.dsp);
      for (let offset = 0; offset < n; offset += FAUST_BLOCK_FRAMES) {
        const count = Math.min(FAUST_BLOCK_FRAMES, n - offset);
        loadInputs(this.dsp, input, offset, count);
        this.dsp.compute(count);
        storeOutputs(this.dsp, output, offset, count);
      }
    }

    override reset(): void {
      this.dsp.clear();
    }
  };
}
