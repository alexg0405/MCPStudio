import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DUCKER_ID = 'agstudio.ducker';

export const duckerParams = {
  depth: p.float(0, 1, 0.8, {
    label: 'Depth',
    unit: '%',
    group: 'Duck',
    hint: 'How far the volume dips on each hit (100% = all the way to silence)',
  }),
  threshold: p.float(-60, 0, -30, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Duck',
    hint: 'How loud a hit must be to duck: hits on the sidechain track, or on this track when none is chosen',
  }),
  attack: p.float(0, 50, 2, { label: 'Attack', unit: 'ms', group: 'Shape', hint: 'How fast the volume dips' }),
  hold: p.float(0, 500, 30, {
    label: 'Hold',
    unit: 'ms',
    group: 'Shape',
    hint: 'How long the volume stays down before coming back',
  }),
  release: p.float(10, 2000, 200, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Shape',
    hint: 'How long the volume takes to come back up',
  }),
  curve: p.float(-1, 1, 0.3, {
    label: 'Release curve',
    unit: '%',
    group: 'Shape',
    hint: 'How it comes back up: below 0% fast then easing in, above 0% stays down then swells back (the classic pump)',
  }),
};
