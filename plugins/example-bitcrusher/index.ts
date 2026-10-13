/**
 * Example user plugin: a bitcrusher effect with its DSP in an AudioWorklet kernel (dsp.worklet.ts).
 * Copy this folder to start your own effect, or run
 *   npm run new:plugin -- --kind effect --style worklet --id user.my-effect
 * Add it to a mixer insert (Mixer → an empty effect slot). Edit dsp.worklet.ts while `npm run dev`
 * runs and audio restarts with your change; the knob settings are kept.
 */
import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletEffect({
  id: ID,
  name: 'Bitcrusher (example)',
  version: 1,
  category: 'Distortion',
  description: 'Example user plugin: lo-fi bit depth and sample-rate reduction in a worklet kernel.',
  params,
  processor,
  presets: [
    { name: '8-bit', params: { bits: 8, downsample: 2 } },
    { name: '12-bit sampler', params: { bits: 12, downsample: 3 } },
    { name: 'Destroyed', params: { bits: 3, downsample: 12 } },
    { name: 'Subtle grit', params: { bits: 10, downsample: 1, mix: 0.5 } },
  ],
});
