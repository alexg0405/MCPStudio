/**
 * __PLUGIN_NAME__: an instrument written in Faust (voice.dsp). Notes play its freq, gain and gate
 * controls; the other controls become knobs. Guide: docs/plugin-sdk.md ("Faust plugins").
 */
import { defineFaustInstrument } from '@agstudio/sdk/faust';
import dsp from './voice.dsp';

export default defineFaustInstrument({
  id: '__PLUGIN_ID__',
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'Synths',
  description: 'A filtered saw synth written in Faust.',
  dsp,
  presets: [
    { name: 'Plucky lead', params: { cutoff: 3200, attack: 0.002, release: 0.15 } },
    { name: 'Slow pad', params: { cutoff: 1400, attack: 0.6, release: 1.8 } },
  ],
});
