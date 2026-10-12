import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './pluck.worklet.ts?worker&url';
import { PLUCK_ID, pluckParams } from './params';

/** Plucked string (Karplus-Strong). The reference example of a worklet (custom DSP) instrument. */
export default defineWorkletInstrument({
  id: PLUCK_ID,
  name: 'Pluck',
  version: 1,
  category: 'Synths',
  description: 'Plucked string: physical-model synth running in an AudioWorklet kernel.',
  params: pluckParams,
  processor,
  tailTime: 3,
  presets: [
    { name: 'Nylon', params: { tone: 0.35, damping: 0.55, decay: 2 } },
    { name: 'Harp', params: { tone: 0.75, damping: 0.2, decay: 5 } },
    { name: 'Muted', params: { tone: 0.3, damping: 0.85, decay: 0.4 } },
  ],
});
