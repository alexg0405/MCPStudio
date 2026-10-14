/**
 * __PLUGIN_NAME__: an effect written in Faust (effect.dsp). Its Faust controls become the knobs.
 * Guide: docs/plugin-sdk.md ("Faust plugins"). Faust language: https://faustdoc.grame.fr
 */
import { defineFaustEffect } from '@agstudio/sdk/faust';
import dsp from './effect.dsp';

export default defineFaustEffect({
  id: '__PLUGIN_ID__',
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'Filters',
  description: 'A resonant low-pass filter written in Faust.',
  dsp,
  presets: [
    { name: 'Soft dark', params: { cutoff: 700, resonance: 0.8, mix: 1 } },
    { name: 'Singing peak', params: { cutoff: 1800, resonance: 8, mix: 1 } },
  ],
});
