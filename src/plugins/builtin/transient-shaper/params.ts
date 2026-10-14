import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const TRANSIENT_ID = 'agstudio.transient';

export const transientParams = {
  attack: p.float(-1, 1, 0, {
    label: 'Attack',
    unit: '%',
    group: 'Shape',
    hint: 'More (above 0%) or less (below 0%) of the hit at the start of each sound',
  }),
  sustain: p.float(-1, 1, 0, {
    label: 'Sustain',
    unit: '%',
    group: 'Shape',
    hint: 'More (above 0%) or less (below 0%) of the tail and room after each hit',
  }),
  length: p.float(5, 100, 20, {
    label: 'Attack length',
    unit: 'ms',
    scale: 'log',
    group: 'Shape',
    hint: 'How long the start of a sound counts as the attack: short for clicks, longer for the body of a hit',
  }),
  output: p.float(-24, 12, 0, {
    label: 'Output',
    unit: 'dB',
    group: 'Output',
    hint: 'Overall level after shaping',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend of the shaped sound with the original',
  }),
};
