import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (dsp.worklet.ts).
export const ID = 'user.bit-crusher';

export const params = {
  bits: p.int(1, 16, 8, { label: 'Bits', group: 'Crush', hint: 'Bit depth: fewer bits, more grit and noise' }),
  rate: p.float(200, 48000, 12000, {
    label: 'Sample rate',
    unit: 'Hz',
    scale: 'log',
    group: 'Crush',
    hint: 'How often the sound is looked at: lower is darker and more aliased (above the real rate it does nothing)',
  }),
  mix: p.float(0, 1, 1, { label: 'Mix', unit: '%', group: 'Output', hint: '0 = the clean sound, 100% = only the crushed sound' }),
};
