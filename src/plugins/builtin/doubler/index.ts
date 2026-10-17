import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './doubler.worklet.ts?worker&url';
import { DOUBLER_ID, doublerParams } from './params';

/**
 * Vocal doubler (worklet kernel): layers two to four quiet, slightly late and slightly out-of-tune
 * copies of a voice, spread to the sides, under the untouched original. It keeps a clean mono sum.
 */
export default defineWorkletEffect({
  id: DOUBLER_ID,
  name: 'Doubler',
  version: 1,
  category: 'Modulation',
  description: 'Makes one vocal sound like two or more takes: quiet late copies with a little pitch drift, spread wide.',
  params: doublerParams,
  processor,
  // The longest voice is 1.9 × the Delay (95 ms at most) plus its drift.
  tailTime: 0.2,
  presets: [
    {
      name: 'Tight double',
      params: { voices: 2, delay: 14, spread: 0.25, drift: 4, width: 0.55, level: -10, tone: 9000 },
    },
    {
      name: 'Wide pop',
      params: { voices: 4, delay: 24, spread: 0.6, drift: 7, width: 1, level: -8, tone: 11000 },
    },
    {
      name: 'Rap ad-lib',
      params: { voices: 2, delay: 32, spread: 0.4, drift: 9, width: 0.9, level: -6, tone: 6500 },
    },
  ],
});
