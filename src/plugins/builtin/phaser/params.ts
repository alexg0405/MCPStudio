import { p } from '@agstudio/sdk/params';
import { SYNC_LABELS, SYNC_OPTIONS } from '@agstudio/sdk/dsp/tempo';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const PHASER_ID = 'agstudio.phaser';
export { SYNC_BEATS } from '@agstudio/sdk/dsp/tempo';

export const STAGES = ['4', '6', '8', '12'] as const;

export const phaserParams = {
  rate: p.float(0.02, 5, 0.3, {
    label: 'Rate',
    unit: 'Hz',
    scale: 'log',
    group: 'Motion',
    hint: 'How fast the sweep moves, in cycles per second (used when Sync is off)',
  }),
  sync: p.enum(SYNC_OPTIONS, 'off', {
    label: 'Sync',
    group: 'Motion',
    labels: SYNC_LABELS,
    hint: 'Locks the sweep to the song: one cycle per note length. Off uses the Rate knob',
  }),
  depth: p.float(0, 1, 0.8, {
    label: 'Depth',
    unit: '%',
    group: 'Motion',
    hint: 'How much of the range between Low and High the sweep covers',
  }),
  low: p.float(40, 4000, 250, {
    label: 'Low',
    unit: 'Hz',
    scale: 'log',
    group: 'Sweep',
    hint: 'The lowest point of the sweep',
  }),
  high: p.float(200, 16000, 3500, {
    label: 'High',
    unit: 'Hz',
    scale: 'log',
    group: 'Sweep',
    hint: 'The highest point of the sweep',
  }),
  stages: p.enum(STAGES, '4', {
    label: 'Stages',
    group: 'Sound',
    labels: { '4': '4 stages (classic)', '6': '6 stages', '8': '8 stages (deeper)', '12': '12 stages (thick)' },
    hint: 'More stages make more notches: a deeper, thicker swirl',
  }),
  feedback: p.float(-0.9, 0.9, 0.3, {
    label: 'Feedback',
    unit: '%',
    group: 'Sound',
    hint: 'Resonance: sharper, more whistling notches (below 0% a different, hollow colour)',
  }),
  width: p.float(0, 1, 0.5, {
    label: 'Width',
    unit: '%',
    group: 'Sound',
    hint: 'How far apart the left and right sweeps are (0% = both sides together)',
  }),
  mix: p.float(0, 1, 0.5, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'How much phasing is blended in (50% gives the deepest notches)',
  }),
};
