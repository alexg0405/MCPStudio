import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './stereo.worklet.ts?worker&url';
import { STEREO_ID, stereoParams } from './params';

/** Mid/side stereo tool: width, mono bass, a Haas widener for mono sounds, balance and phase flips. */
export default defineWorkletEffect({
  id: STEREO_ID,
  name: 'Stereo',
  version: 1,
  category: 'Stereo',
  description: 'Makes sounds wider or narrower in the stereo field, keeps the bass mono and fixes phase problems.',
  params: stereoParams,
  processor,
  tailTime: 0.04,
  presets: [
    { name: 'Wide (150%)', params: { width: 1.5, monoBelow: 100 } },
    { name: 'Widen a mono sound (Haas 12 ms)', params: { haas: 12, width: 1.2 } },
    { name: 'Mono bass below 120 Hz', params: { monoBelow: 120 } },
    { name: 'Extra wide pads (200%)', params: { width: 2, monoBelow: 150 } },
    { name: 'Narrow (50%)', params: { width: 0.5 } },
    { name: 'Mono check', params: { width: 0 } },
    { name: 'Fix out-of-phase left side', params: { flip: 'left' } },
  ],
});
