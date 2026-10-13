import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const GATE_ID = 'agstudio.gate';

export const gateParams = {
  threshold: p.float(-80, 0, -40, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Gate',
    hint: 'Lets sound through only while it is louder than this (the sidechain track decides, or this track itself)',
  }),
  range: p.float(-80, 0, -80, {
    label: 'Closed level',
    unit: 'dB',
    group: 'Gate',
    hint: 'How quiet it gets while closed: -80 dB is silent, -10 dB only a little quieter',
  }),
  attack: p.float(0.05, 50, 0.5, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast it opens when the sound starts',
  }),
  hold: p.float(0, 500, 50, {
    label: 'Hold',
    unit: 'ms',
    group: 'Timing',
    hint: 'How long it stays open after the sound drops',
  }),
  release: p.float(5, 2000, 100, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast it closes after the hold',
  }),
  listen: p.bool(false, {
    label: 'Listen to sidechain',
    group: 'Gate',
    hint: 'Hear what opens the gate: the chosen sidechain track, or this track itself',
  }),
};
