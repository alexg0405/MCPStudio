import { dbToGain, defineEffect, p } from '@agstudio/sdk';

const TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'] as const;
type FilterType = (typeof TYPES)[number];

const params = {
  type: p.enum(TYPES, 'lowpass', {
    label: 'Type',
    group: 'Filter',
    labels: { lowpass: 'Low-pass', highpass: 'High-pass', bandpass: 'Band-pass', notch: 'Notch' },
  }),
  cutoff: p.float(20, 20000, 1000, { label: 'Cutoff', unit: 'Hz', scale: 'log', group: 'Filter', smoothing: 0.015 }),
  resonance: p.float(0.1, 20, 0.707, {
    label: 'Resonance',
    scale: 'log',
    group: 'Filter',
    hint: 'Q: emphasis at the cutoff (0.71 = no peak); for band-pass and notch, how narrow the band is',
  }),
  output: p.float(-24, 12, 0, { label: 'Output', unit: 'dB', scale: 'db', group: 'Output' }),
};

/**
 * Web Audio's low/high-pass filters take Q as a resonance in dB, band-pass and notch as a plain Q.
 * The knob is always a plain Q, converted here.
 */
const toNodeQ = (type: FilterType, q: number) => (type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q);

/** One resonant filter (native BiquadFilterNode) with four modes. */
export default defineEffect({
  id: 'agstudio.filter',
  name: 'Filter',
  version: 1,
  category: 'Filters',
  description: 'Resonant low-pass, high-pass, band-pass or notch filter.',
  params,
  presets: [
    { name: 'Low-pass 2 kHz', params: { cutoff: 2000 } },
    { name: 'Resonant low-pass', params: { cutoff: 600, resonance: 8 } },
    { name: 'High-pass 200 Hz', params: { type: 'highpass', cutoff: 200 } },
    { name: 'Telephone band', params: { type: 'bandpass', cutoff: 1500, resonance: 1.2 } },
    { name: 'Notch 1 kHz', params: { type: 'notch', cutoff: 1000, resonance: 4 } },
  ],

  create({ audioContext: ac, params: P }) {
    let type: FilterType = P.type.value;
    const filter = new BiquadFilterNode(ac, { type });
    const out = new GainNode(ac);
    filter.connect(out);
    P.cutoff.bind(filter.frequency);
    P.resonance.bind(filter.Q, (q) => toNodeQ(type, q));
    P.output.bind(out.gain, dbToGain);
    P.type.onChange((next, time) => {
      type = next;
      filter.type = next;
      filter.Q.setValueAtTime(toNodeQ(next, P.resonance.value), time);
    });
    return {
      input: filter,
      output: out,
      dispose() {
        filter.disconnect();
        out.disconnect();
      },
    };
  },
});
