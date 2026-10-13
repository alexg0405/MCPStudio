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
  description: 'Compressor with soft knee, makeup gain and a sidechain input (with a high-pass and listen).',
  params: compressorParams,
  processor,
  sidechain: true,
  presets: [
    { name: 'Gentle glue', params: { threshold: -18, ratio: 2, knee: 10, attack: 10, release: 200, makeup: 2 } },
    { name: 'Vocal', params: { threshold: -20, ratio: 3, knee: 6, attack: 5, release: 120, makeup: 4 } },
    { name: 'Drum punch', params: { threshold: -16, ratio: 4, knee: 3, attack: 20, release: 80, makeup: 3 } },
    { name: 'Squash', params: { threshold: -35, ratio: 12, knee: 0, attack: 1, release: 60, makeup: 10 } },
    { name: 'Peak catcher', params: { threshold: -6, ratio: 20, knee: 0, attack: 0.5, release: 50, makeup: 3 } },
    {
      name: 'Sidechain pump',
      params: { threshold: -32, ratio: 10, knee: 6, attack: 1, release: 180, makeup: 0, scFilter: 100 },
    },
  ],
});
