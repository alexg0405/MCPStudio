import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const GATE_ID = 'agstudio.gate';

export const gateParams = {
  threshold: p.float(-80, 0, -40, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Gate',
    hint: 'Opens when the key gets louder than this (the sidechain track, or this track itself)',
  }),
  range: p.float(-80, 0, -80, {
    label: 'Range',
    unit: 'dB',
    group: 'Gate',
    hint: 'How far it turns the sound down while closed (-80 dB = silent)',
  }),
  attack: p.float(0.05, 50, 0.5, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast it opens',
  }),
  hold: p.float(0, 500, 50, {
    label: 'Hold',
    unit: 'ms',
    group: 'Timing',
    hint: 'Stays open this long after the key drops',
  }),
  release: p.float(5, 2000, 100, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast it closes',
  }),
  listen: p.bool(false, { label: 'Listen', group: 'Gate', hint: 'Hear the key that opens the gate' }),
};
