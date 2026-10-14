/**
 * Example: an instrument written in Faust (organ.dsp). Edit the .dsp while AGstudio runs: it
 * recompiles and the knobs follow. Guide: docs/plugin-sdk.md ("Faust plugins").
 */
import { defineFaustInstrument } from '@agstudio/sdk/faust';
import dsp from './organ.dsp';

export default defineFaustInstrument({
  id: 'user.example-faust-organ',
  name: 'Faust Organ (example)',
  version: 1,
  category: 'Keys',
  description: 'A drawbar organ written in Faust: an example of a Faust instrument plugin.',
  dsp,
  presets: [
    { name: 'Gospel full', params: { lowDrawbar: 0.9, middleDrawbar: 1, highDrawbar: 0.8, keyClick: 0.3 } },
    { name: 'Soft flute', params: { lowDrawbar: 0, middleDrawbar: 0.9, highDrawbar: 0.2, keyClick: 0 } },
    { name: 'Bright percussive', params: { lowDrawbar: 0.3, middleDrawbar: 0.6, highDrawbar: 1, keyClick: 0.6 } },
  ],
});
