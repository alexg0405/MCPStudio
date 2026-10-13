import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DUCKER_ID = 'agstudio.ducker';

export const duckerParams = {
  depth: p.float(0, 1, 0.8, {
    label: 'Depth',
    unit: '%',
    group: 'Duck',
    hint: 'How far the level dips when the key hits (100 % = silence)',
  }),
  threshold: p.float(-60, 0, -30, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Duck',
    hint: 'A hit on the key (the sidechain track, or this track itself when none is chosen) louder than this triggers the duck',
  }),
  attack: p.float(0, 50, 2, { label: 'Attack', unit: 'ms', group: 'Shape', hint: 'Time to reach full depth' }),
  hold: p.float(0, 500, 30, {
    label: 'Hold',
    unit: 'ms',
    group: 'Shape',
    hint: 'Time at full depth before coming back up',
  }),
  release: p.float(10, 2000, 200, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Shape',
    hint: 'Time to come back up',
  }),
  curve: p.float(-1, 1, 0.3, {
    label: 'Curve',
    group: 'Shape',
    hint: 'Recovery shape: negative comes back fast then eases in, positive stays down then swells back (pumping)',
  }),
};
