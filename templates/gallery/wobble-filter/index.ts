/**
 * Wobble Filter: an effect written in Faust (filter.dsp). A resonant low-pass filter that a slow wave sweeps up and down.
 * Guide: docs/plugin-sdk.md ("Faust plugins"). Faust language: https://faustdoc.grame.fr
 */
import { defineFaustEffect } from '@agstudio/sdk/faust';
import dsp from './filter.dsp';

export default defineFaustEffect({
  id: 'user.wobble-filter',
  name: 'Wobble Filter',
  version: 1,
  category: 'Filters',
  description: 'A resonant low-pass filter that a slow wave sweeps up and down: wobbles, wah and filter risers.',
  dsp,
  presets: [
    { name: 'Slow wobble', params: { cutoff: 700, resonance: 4, rate: 0.6, depth: 1.8, mix: 1 } },
    { name: 'Dubstep growl', params: { cutoff: 500, resonance: 8, rate: 3, depth: 2.4, mix: 1 } },
    { name: 'Gentle breathing', params: { cutoff: 2500, resonance: 1.5, rate: 0.2, depth: 0.8, mix: 0.7 } },
  ],
});
