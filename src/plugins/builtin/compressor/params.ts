import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
// The first six ids and ranges are the v1 Compressor's, so saved projects and presets keep working.
export const COMPRESSOR_ID = 'agstudio.compressor';

export const compressorParams = {
  threshold: p.float(-60, 0, -18, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Compression',
    hint: 'Level above which the signal is turned down',
  }),
  ratio: p.float(1, 20, 4, {
    label: 'Ratio',
    unit: 'x',
    scale: 'log',
    group: 'Compression',
    hint: 'How hard: at 4x, 4 dB over the threshold comes out as 1 dB',
  }),
  knee: p.float(0, 40, 6, {
    label: 'Knee',
    unit: 'dB',
    group: 'Compression',
    hint: 'Width of the soft transition around the threshold',
  }),
  attack: p.float(0.5, 200, 5, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast compression starts (slower lets transients through)',
  }),
  release: p.float(10, 1000, 150, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast the level recovers',
  }),
  makeup: p.float(-12, 24, 0, { label: 'Makeup', unit: 'dB', group: 'Output', hint: 'Gain after compression' }),
  scFilter: p.float(20, 2000, 20, {
    label: 'SC filter',
    unit: 'Hz',
    scale: 'log',
    group: 'Sidechain',
    hint: 'High-pass on what the compressor listens to (20 Hz = off): higher ignores the lows (less pumping from bass)',
  }),
  listen: p.bool(false, {
    label: 'Listen',
    group: 'Sidechain',
    hint: 'Hear what the compressor reacts to (the filtered sidechain, or its own input when none is chosen)',
  }),
};
