/**
 * __PLUGIN_NAME__: an effect built from native Web Audio nodes. Effects go in mixer insert slots.
 * Guide: docs/plugin-sdk.md
 */
import { dbToGain, defineEffect, p } from '@agstudio/sdk';

export default defineEffect({
  id: '__PLUGIN_ID__',
  name: '__PLUGIN_NAME__',
  version: 1,
  category: 'Filters',
  params: {
    cutoff: p.float(40, 18000, 2000, { label: 'Cutoff', unit: 'Hz', scale: 'log' }),
    resonance: p.float(0.1, 12, 0.7, { label: 'Resonance', scale: 'log' }),
    output: p.float(-24, 12, 0, { label: 'Output', unit: 'dB', scale: 'db' }),
  },

  create({ audioContext: ac, params }) {
    const filter = new BiquadFilterNode(ac, { type: 'lowpass' });
    const gain = new GainNode(ac);
    filter.connect(gain);
    params.cutoff.bind(filter.frequency);
    params.resonance.bind(filter.Q);
    params.output.bind(gain.gain, dbToGain);
    return {
      input: filter,
      output: gain,
      dispose: () => {
        filter.disconnect();
        gain.disconnect();
      },
    };
  },
});
