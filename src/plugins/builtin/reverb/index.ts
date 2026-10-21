import { defineEffect } from '@agstudio/sdk';
import processor from './reverb.worklet.ts?worker&url';
import { createEngines } from './engines';
import { REVERB_ID, reverbParams, reverbTail } from './params';

/**
 * Two engines behind the same knobs. Algorithmic (the default): the AudioWorklet kernel in
 * kernel.ts, a feedback delay network whose cost doesn't depend on Decay, with the mix inside it.
 * Convolution: the original ConvolverNode engine, built only while chosen. Switching crossfades
 * the two; the one faded out stops getting input (an unfed kernel sleeps once its tail is over).
 */
export default defineEffect({
  id: REVERB_ID,
  name: 'Reverb',
  version: 1,
  category: 'Reverb',
  description:
    'Stereo reverb: decay, pre-delay, damping and room size. The algorithmic engine is light on the CPU at any length; the convolution engine is the original sound.',
  params: reverbParams,
  processor,
  presets: [
    { name: 'Room', params: { decay: 0.8, size: 0.35, damping: 0.6, preDelay: 0.008, mix: 0.25 } },
    { name: 'Hall', params: { decay: 3.2, size: 0.85, damping: 0.4, preDelay: 0.03, mix: 0.3 } },
    { name: 'Plate', params: { decay: 1.8, size: 0.5, damping: 0.15, preDelay: 0.01, mix: 0.3 } },
    { name: 'Ambience', params: { decay: 0.5, size: 0.2, damping: 0.7, preDelay: 0, mix: 0.2 } },
    { name: 'Cathedral', params: { decay: 7, size: 1, damping: 0.5, preDelay: 0.05, mix: 0.35 } },
  ],

  async create(host) {
    const params = host.params;
    const kernel = await host.worklet({ numberOfInputs: 1, outputChannelCount: [2] });
    const input = new GainNode(host.audioContext);
    const output = new GainNode(host.audioContext);
    const engines = createEngines(host, kernel, input, output);

    return {
      input,
      output,
      sleep: engines.sleep,
      get tailTime() {
        return reverbTail(params.decay.value, params.preDelay.value);
      },
      reset: engines.reset,
      dispose() {
        engines.dispose();
        kernel.dispose();
        for (const node of [input, output]) node.disconnect();
      },
    };
  },
});
