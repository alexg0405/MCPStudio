/**
 * FM Bell: a simple two-operator FM instrument that rings like a struck bell.
 * Guide: docs/plugin-sdk.md
 */
import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';
import { ID, params } from './params';

export default defineWorkletInstrument({
  id: ID,
  name: 'FM Bell',
  version: 1,
  category: 'Synths',
  description: 'A simple FM bell: two sine operators that ring and fade like a struck metal bar.',
  params,
  processor,
  presets: [
    { name: 'Church bell', params: { ratio: 3.5, brightness: 2.5, ring: 3, release: 0.6 } },
    { name: 'Glass chime', params: { ratio: 5.4, brightness: 1.6, ring: 2, release: 0.4 } },
    { name: 'Soft celesta', params: { ratio: 4, brightness: 0.9, ring: 1.1, release: 0.3 } },
    { name: 'Dark gong', params: { ratio: 1.4, brightness: 4.5, ring: 6, release: 1.5 } },
  ],
});
