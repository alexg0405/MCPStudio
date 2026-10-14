import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const STEREO_ID = 'agstudio.stereo';

/** `monoBelow` at its minimum means "off". */
export const MONO_OFF_HZ = 20;

export const FLIPS = ['off', 'left', 'right', 'both'] as const;

export const stereoParams = {
  width: p.float(0, 2, 1, {
    label: 'Width',
    unit: '%',
    group: 'Stereo',
    hint: 'How wide the sound is: 0% is mono, 100% unchanged, 200% extra wide',
  }),
  monoBelow: p.float(MONO_OFF_HZ, 500, MONO_OFF_HZ, {
    label: 'Mono bass below',
    unit: 'Hz',
    scale: 'log',
    group: 'Stereo',
    hint: 'Makes everything under this frequency mono, so the low end stays solid on any system (20 Hz = off)',
  }),
  haas: p.float(0, 30, 0, {
    label: 'Mono widener',
    unit: 'ms',
    group: 'Stereo',
    hint: 'Widens mono sounds by delaying the right side a little (0 = off; keep it short, it sounds hollow in mono)',
  }),
  balance: p.float(-1, 1, 0, {
    label: 'Balance',
    unit: '%',
    group: 'Output',
    hint: 'Turns one side down to move the sound left (below 0%) or right (above 0%)',
  }),
  flip: p.enum(FLIPS, 'off', {
    label: 'Phase flip',
    group: 'Output',
    labels: { off: 'Off', left: 'Flip left', right: 'Flip right', both: 'Flip both' },
    hint: 'Turns a channel upside down: fixes a recording whose sides cancel each other in mono',
  }),
};
