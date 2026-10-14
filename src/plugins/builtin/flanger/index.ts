import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './flanger.worklet.ts?worker&url';
import { FLANGER_ID, flangerParams } from './params';

/** Stereo flanger with feedback, free-running or synced to the song. */
export default defineWorkletEffect({
  id: FLANGER_ID,
  name: 'Flanger',
  version: 1,
  category: 'Modulation',
  description: 'Sweeps a metallic "jet plane" whoosh through the sound with a short, moving delay.',
  params: flangerParams,
  processor,
  tailTime: 0.2,
  presets: [
    { name: 'Jet flanger', params: { rate: 0.15, depth: 0.9, delay: 1, feedback: 0.7, width: 0.3, mix: 0.5 } },
    { name: 'Synced sweep (1 bar)', params: { sync: '1 bar', depth: 0.8, delay: 1.2, feedback: 0.6, mix: 0.5 } },
    { name: 'Subtle flange', params: { rate: 0.2, depth: 0.4, delay: 2, feedback: 0.2, width: 0.6, mix: 0.35 } },
    { name: 'Metallic resonance', params: { rate: 0.5, depth: 0.5, delay: 0.6, feedback: 0.9, mix: 0.5 } },
    { name: 'Hollow negative flange', params: { rate: 0.3, depth: 0.7, delay: 1.5, feedback: -0.8, mix: 0.5 } },
    { name: 'Wide stereo flange', params: { rate: 0.12, depth: 0.8, delay: 2.5, feedback: 0.4, width: 1, mix: 0.5 } },
  ],
});
