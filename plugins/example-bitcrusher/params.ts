import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (dsp.worklet.ts).
// Editing this file reloads the page (both threads use it); editing dsp.worklet.ts only restarts audio.
export const ID = 'user.example-bitcrusher';

export const params = {
  bits: p.int(1, 16, 8, { label: 'Bits', group: 'Crush', hint: 'Bit depth: fewer bits, more grit' }),
  downsample: p.int(1, 32, 4, {
    label: 'Downsample',
    group: 'Crush',
    hint: 'Holds each sample for this many frames (a lower, aliasing sample rate)',
  }),
  mix: p.float(0, 1, 1, { label: 'Mix', unit: '%', group: 'Output' }),
};
