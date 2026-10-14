import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './transient.worklet.ts?worker&url';
import { TRANSIENT_ID, transientParams } from './params';

/** Attack/sustain shaper: louder or softer hits, longer or shorter tails, whatever the level. */
export default defineWorkletEffect({
  id: TRANSIENT_ID,
  name: 'Transient Shaper',
  version: 1,
  category: 'Dynamics',
  description: 'Makes hits punchier or softer and tails longer or shorter, without a threshold to set.',
  params: transientParams,
  processor,
  presets: [
    { name: 'Punchy drums', params: { attack: 0.6, sustain: -0.2, length: 20 } },
    { name: 'Snappy snare', params: { attack: 0.8, sustain: -0.1, length: 10, output: -1 } },
    { name: 'Tighten tails (less room)', params: { attack: 0.1, sustain: -0.8, length: 20 } },
    { name: 'Soften harsh attacks', params: { attack: -0.6, sustain: 0, length: 15 } },
    { name: 'Room boost (more sustain)', params: { attack: 0, sustain: 0.7, length: 25, output: -2 } },
    { name: 'Pluck sharpener', params: { attack: 0.5, sustain: -0.3, length: 8 } },
  ],
});
