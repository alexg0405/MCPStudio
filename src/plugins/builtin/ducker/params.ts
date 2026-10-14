import { p } from '@agstudio/sdk/params';
import { NOTE_LABELS, noteBeats } from '@agstudio/sdk/dsp/tempo';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DUCKER_ID = 'agstudio.ducker';

/** How often the tempo pump ducks. */
export const PUMP_RATES = ['1 bar', '1/2', '1/4', '1/8', '1/16', '1/4d', '1/8d', '1/4t', '1/8t'] as const;
/** Beats between ducks for each PUMP_RATES option. */
export const PUMP_BEATS = PUMP_RATES.map((r) => noteBeats(r));

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
    hint: 'How long the volume takes to come back up (the tempo pump keeps it within one step)',
  }),
  curve: p.float(-1, 1, 0.3, {
    label: 'Release curve',
    unit: '%',
    group: 'Shape',
    hint: 'How it comes back up: below 0% fast then easing in, above 0% stays down then swells back (the classic pump)',
  }),
  // Added in M14 (defaults keep older projects and presets as they were).
  mode: p.enum(['sidechain', 'tempo'], 'sidechain', {
    label: 'Mode',
    group: 'Duck',
    labels: { sidechain: 'Sidechain hits', tempo: 'Tempo pump (no sidechain needed)' },
    hint: 'What makes it duck: hits on the sidechain track (or this track), or a steady pump locked to the song tempo',
  }),
  rate: p.enum(PUMP_RATES, '1/4', {
    label: 'Pump rate',
    group: 'Duck',
    labels: { ...NOTE_LABELS, '1 bar': '1 bar (4 beats)', '1/4': '1/4 (every beat)' },
    hint: 'Tempo pump: how often it ducks, on the song’s grid (only while the song plays)',
  }),
};
