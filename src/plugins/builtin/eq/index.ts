import { defineEffect, p } from '@agstudio/sdk';

const gain = (group: string) =>
  p.float(-18, 18, 0, { label: 'Gain', unit: 'dB', group, hint: 'Boost or cut this band (double-click: 0 dB)' });

const params = {
  lowFreq: p.float(20, 1000, 120, { label: 'Freq', unit: 'Hz', scale: 'log', group: 'Low shelf' }),
  lowGain: gain('Low shelf'),
  midFreq: p.float(80, 12000, 1000, { label: 'Freq', unit: 'Hz', scale: 'log', group: 'Mid' }),
  midGain: gain('Mid'),
  midQ: p.float(0.1, 18, 1, {
    label: 'Q',
    scale: 'log',
    group: 'Mid',
    hint: 'Width of the mid band: low Q is broad, high Q is narrow',
  }),
  highFreq: p.float(1000, 20000, 8000, { label: 'Freq', unit: 'Hz', scale: 'log', group: 'High shelf' }),
  highGain: gain('High shelf'),
};

/** Three-band EQ: low shelf, peaking mid and high shelf (native BiquadFilterNodes in series). */
export default defineEffect({
  id: 'agstudio.eq',
  name: 'EQ',
  version: 1,
  category: 'EQ',
  description: '3-band EQ: low shelf, sweepable mid and high shelf, ±18 dB.',
  params,
  presets: [
    { name: 'Flat', params: {} },
    { name: 'Low boost', params: { lowFreq: 90, lowGain: 6 } },
    { name: 'Smile', params: { lowGain: 4, midFreq: 900, midGain: -3, midQ: 0.7, highGain: 4 } },
    { name: 'Presence', params: { midFreq: 3500, midGain: 4, midQ: 1.2 } },
    { name: 'Air', params: { highFreq: 12000, highGain: 5 } },
    {
      name: 'Telephone',
      params: { lowFreq: 400, lowGain: -18, midFreq: 1800, midGain: 6, midQ: 0.8, highFreq: 3500, highGain: -18 },
    },
  ],

  create({ audioContext: ac, params: P }) {
    const low = new BiquadFilterNode(ac, { type: 'lowshelf' });
    const mid = new BiquadFilterNode(ac, { type: 'peaking' });
    const high = new BiquadFilterNode(ac, { type: 'highshelf' });
    low.connect(mid).connect(high);
    P.lowFreq.bind(low.frequency);
    P.lowGain.bind(low.gain);
    P.midFreq.bind(mid.frequency);
    P.midGain.bind(mid.gain);
    P.midQ.bind(mid.Q);
    P.highFreq.bind(high.frequency);
    P.highGain.bind(high.gain);
    return {
      input: low,
      output: high,
      dispose() {
        low.disconnect();
        mid.disconnect();
        high.disconnect();
      },
    };
  },
});
