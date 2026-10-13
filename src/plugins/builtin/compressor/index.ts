import { defineWorkletEffect } from '@agstudio/sdk';
import processor from './compressor.worklet.ts?worker&url';
import { COMPRESSOR_ID, compressorParams } from './params';

/**
 * Feed-forward compressor (worklet kernel, zero latency) that can listen to a sidechain: pick a
 * track under the slot's "Sidechain from" menu (or "Sidechain to this track" on that track's
 * strip) to duck this insert to it; with none chosen it compresses on its own input.
 */
export default defineWorkletEffect({
  id: COMPRESSOR_ID,
  name: 'Compressor',
  version: 1,
  category: 'Dynamics',
  description: 'Evens out levels; can also react to another track (sidechain) to make room for it.',
  params: compressorParams,
  processor,
  sidechain: true,
  presets: [
    {
      name: 'Gentle glue for a bus',
      params: { threshold: -18, ratio: 2, knee: 10, attack: 10, release: 200, makeup: 2 },
    },
    { name: 'Smooth vocals', params: { threshold: -20, ratio: 3, knee: 6, attack: 5, release: 120, makeup: 4 } },
    {
      name: 'Punchy drums (slow attack)',
      params: { threshold: -16, ratio: 4, knee: 3, attack: 20, release: 80, makeup: 3 },
    },
    { name: 'Heavy squash', params: { threshold: -35, ratio: 12, knee: 0, attack: 1, release: 60, makeup: 10 } },
    {
      name: 'Catch the loudest peaks',
      params: { threshold: -6, ratio: 20, knee: 0, attack: 0.5, release: 50, makeup: 3 },
    },
    {
      name: 'Pump to the kick (set Sidechain from)',
      params: { threshold: -32, ratio: 10, knee: 6, attack: 1, release: 180, makeup: 0, scFilter: 100 },
    },
  ],
});
