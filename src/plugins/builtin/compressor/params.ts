import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
// The first six ids and ranges are the v1 Compressor's, so saved projects and presets keep working.
export const COMPRESSOR_ID = 'agstudio.compressor';

export const compressorParams = {
  threshold: p.float(-60, 0, -18, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Compression',
    hint: 'Level above which the sound gets turned down',
  }),
  ratio: p.float(1, 20, 4, {
    label: 'Ratio',
    unit: 'x',
    scale: 'log',
    group: 'Compression',
    hint: 'How hard it turns down: at 4x, 4 dB over the threshold comes out 1 dB over (1x = off)',
  }),
  knee: p.float(0, 40, 6, {
    label: 'Knee',
    unit: 'dB',
    group: 'Compression',
    hint: 'How gently compression starts around the threshold (0 dB = all at once)',
  }),
  attack: p.float(0.5, 200, 5, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast it turns down once the sound goes over: slower lets drum hits punch through',
  }),
  release: p.float(10, 1000, 150, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast the level comes back up after the sound drops',
  }),
  makeup: p.float(-12, 24, 0, {
    label: 'Makeup gain',
    unit: 'dB',
    group: 'Output',
    hint: 'Turns the compressed sound back up',
  }),
  scFilter: p.float(20, 2000, 20, {
    label: 'Sidechain filter',
    unit: 'Hz',
    scale: 'log',
    group: 'Sidechain',
    hint: 'Ignore lows below this in what it listens to, so a bass line doesn’t make it pump (20 Hz = off)',
  }),
  listen: p.bool(false, {
    label: 'Listen to sidechain',
    group: 'Sidechain',
    hint: 'Hear what the compressor reacts to: the chosen sidechain track (filtered), or its own input',
  }),
};
