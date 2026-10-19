import { p } from '@agstudio/sdk';

const WAVES = ['sine', 'triangle', 'sawtooth', 'square'] as const;
const waveLabels = { sine: 'Sine', triangle: 'Triangle', sawtooth: 'Saw', square: 'Square' };

const shape = (def: (typeof WAVES)[number], group: string) =>
  p.enum(WAVES, def, { label: 'Shape', group, labels: waveLabels });
const coarse = (def: number, group: string) => p.int(-24, 24, def, { label: 'Coarse', unit: 'st', group });
const fine = (def: number, group: string) => p.float(-100, 100, def, { label: 'Fine', unit: 'ct', group });
const level = (def: number, group: string) => p.float(0, 1, def, { label: 'Level', unit: '%', group });

/** The 3xOsc's knobs: three oscillators, the amp envelope, the filter with its envelope, and the output level. */
export const threeOscParams = {
  osc1Wave: shape('sawtooth', 'Osc 1'),
  osc1Coarse: coarse(0, 'Osc 1'),
  osc1Fine: fine(0, 'Osc 1'),
  osc1Level: level(0.8, 'Osc 1'),
  osc2Wave: shape('sawtooth', 'Osc 2'),
  osc2Coarse: coarse(0, 'Osc 2'),
  osc2Fine: fine(7, 'Osc 2'),
  osc2Level: level(0.6, 'Osc 2'),
  osc3Wave: shape('square', 'Osc 3'),
  osc3Coarse: coarse(-12, 'Osc 3'),
  osc3Fine: fine(0, 'Osc 3'),
  osc3Level: level(0.4, 'Osc 3'),
  attack: p.float(0.001, 4, 0.005, { label: 'Attack', unit: 's', scale: 'log', group: 'Amp envelope' }),
  decay: p.float(0.005, 6, 0.3, { label: 'Decay', unit: 's', scale: 'log', group: 'Amp envelope' }),
  sustain: p.float(0, 1, 0.7, { label: 'Sustain', unit: '%', group: 'Amp envelope' }),
  release: p.float(0.005, 6, 0.2, { label: 'Release', unit: 's', scale: 'log', group: 'Amp envelope' }),
  cutoff: p.float(30, 18000, 4000, { label: 'Cutoff', unit: 'Hz', scale: 'log', group: 'Filter' }),
  resonance: p.float(0.1, 18, 1, { label: 'Resonance', scale: 'log', group: 'Filter' }),
  filterEnv: p.float(0, 6, 1.5, {
    label: 'Env amount',
    unit: 'x',
    group: 'Filter',
    hint: 'Octaves the filter opens on each note',
  }),
  filterDecay: p.float(0.01, 4, 0.35, { label: 'Env decay', unit: 's', scale: 'log', group: 'Filter' }),
  level: p.float(-36, 6, -9, { label: 'Level', unit: 'dB', scale: 'db', group: 'Output' }),
} as const;
