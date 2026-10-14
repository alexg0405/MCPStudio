import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './multiband.worklet.ts?worker&url';
import { MULTIBAND_ID, multibandParams } from './params';

/** Three-band compressor with Linkwitz-Riley crossovers; untouched, it sums back flat. */
export default defineWorkletEffect({
  id: MULTIBAND_ID,
  name: 'Multiband',
  version: 1,
  category: 'Dynamics',
  description:
    'Compresses the lows, mids and highs separately, to control boomy bass or harsh highs without squashing everything.',
  params: multibandParams,
  processor,
  tap: true,
  presets: [
    {
      name: 'Gentle master glue',
      params: {
        lowThreshold: -18,
        lowRatio: 2,
        lowAttack: 20,
        lowRelease: 200,
        midThreshold: -18,
        midRatio: 2,
        midAttack: 15,
        midRelease: 180,
        highThreshold: -20,
        highRatio: 2,
        highAttack: 10,
        highRelease: 150,
        output: 1,
      },
    },
    {
      name: 'Loud and punchy master',
      params: {
        lowThreshold: -24,
        lowRatio: 4,
        lowAttack: 15,
        lowRelease: 120,
        lowGain: 4,
        midThreshold: -24,
        midRatio: 3,
        midAttack: 10,
        midRelease: 120,
        midGain: 4,
        highThreshold: -26,
        highRatio: 3,
        highAttack: 5,
        highRelease: 100,
        highGain: 4,
      },
    },
    {
      name: 'Tame harsh highs',
      params: { highFreq: 4000, highThreshold: -30, highRatio: 4, highAttack: 2, highRelease: 80 },
    },
    {
      name: 'Tighten the low end',
      params: { lowFreq: 150, lowThreshold: -24, lowRatio: 4, lowAttack: 30, lowRelease: 150, lowGain: 1 },
    },
    {
      name: 'De-mud the mids',
      params: { lowFreq: 200, highFreq: 1200, midThreshold: -26, midRatio: 3, midAttack: 10, midRelease: 120 },
    },
    {
      name: 'Radio squash',
      params: {
        lowThreshold: -30,
        lowRatio: 8,
        lowGain: 6,
        midThreshold: -32,
        midRatio: 8,
        midGain: 8,
        highThreshold: -32,
        highRatio: 8,
        highGain: 6,
        output: -2,
      },
    },
  ],
});
