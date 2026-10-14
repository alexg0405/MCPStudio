import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './phaser.worklet.ts?worker&url';
import { PHASER_ID, phaserParams } from './params';

/** Stereo phaser (4–12 allpass stages) with feedback, free-running or synced to the song. */
export default defineWorkletEffect({
  id: PHASER_ID,
  name: 'Phaser',
  version: 1,
  category: 'Modulation',
  description: 'Swirls a sound with sweeping notches, from a gentle shimmer to a deep, resonant whoosh.',
  params: phaserParams,
  processor,
  tailTime: 0.1,
  presets: [
    { name: 'Classic 4-stage phaser', params: { rate: 0.3, depth: 0.8, stages: '4', feedback: 0.3, mix: 0.5 } },
    {
      name: 'Synced phaser (1/2)',
      params: { sync: '1/2', depth: 0.9, stages: '6', feedback: 0.5, low: 200, high: 4000, mix: 0.5 },
    },
    {
      name: 'Slow 8-stage swirl',
      params: { rate: 0.08, depth: 1, stages: '8', feedback: 0.4, low: 150, high: 6000, width: 0.7, mix: 0.5 },
    },
    { name: 'Deep resonant phaser', params: { rate: 0.2, depth: 0.9, stages: '12', feedback: 0.8, mix: 0.5 } },
    {
      name: 'Subtle stereo phase',
      params: { rate: 0.15, depth: 0.5, stages: '4', feedback: 0.1, width: 1, mix: 0.35 },
    },
    { name: 'Hollow negative phaser', params: { rate: 0.4, depth: 0.7, stages: '6', feedback: -0.6, mix: 0.5 } },
  ],
});
