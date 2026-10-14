import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const STUTTER_ID = 'agstudio.stutter';

export const GATES = ['off', '1/4', '1/8', '1/16', 'offbeat', 'trance', 'dotted', 'triplet', 'half'] as const;
export const REPEATS = ['off', '1/2', '1/4', '1/8', '1/16', '1/32'] as const;
/** Beats per repeated slice for each REPEATS option. */
export const REPEAT_BEATS = [0, 2, 1, 0.5, 0.25, 0.125] as const;
/** The 16-step (1/16 notes) trance gate pattern, one bar long. */
export const TRANCE = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1] as const;

export const stutterParams = {
  gate: p.enum(GATES, '1/8', {
    label: 'Gate',
    group: 'Gate',
    labels: {
      off: 'Off',
      '1/4': '1/4: on for the first half of every beat',
      '1/8': '1/8: on for the first half of every 1/8',
      '1/16': '1/16: on for the first half of every 1/16',
      offbeat: 'Off-beat: only the second 1/8 of each beat',
      trance: 'Trance: a classic 16-step pattern',
      dotted: 'Dotted: on for the first half of every dotted 1/8',
      triplet: 'Triplet: on for the first half of every 1/8 triplet',
      half: 'Half-time: on one beat, off the next',
    },
    hint: 'A rhythmic chop locked to the song: the sound is cut between the pulses (only while the song plays)',
  }),
  depth: p.float(0, 1, 1, {
    label: 'Gate depth',
    unit: '%',
    group: 'Gate',
    hint: 'How much the gate cuts between pulses (100% = silence)',
  }),
  smooth: p.float(0.5, 30, 3, {
    label: 'Gate smoothing',
    unit: 'ms',
    scale: 'log',
    group: 'Gate',
    hint: 'How soft the gate’s edges are: short is choppy, long is pulsing',
  }),
  repeat: p.enum(REPEATS, 'off', {
    label: 'Beat repeat',
    group: 'Repeat',
    automatable: true,
    labels: {
      off: 'Off',
      '1/2': '1/2 note',
      '1/4': '1/4 note',
      '1/8': '1/8 note',
      '1/16': '1/16 note',
      '1/32': '1/32 note',
    },
    hint: 'Grabs the slice of this length that starts on the grid and loops it while it stays on (automate it for stutter rolls)',
  }),
  stop: p.bool(false, {
    label: 'Tape stop',
    group: 'Tape stop',
    automatable: true,
    hint: 'Slows the sound down to a halt like a stopping tape, then silence until it is switched off (automate it)',
  }),
  stopTime: p.float(0.25, 4, 1, {
    label: 'Stop time',
    unit: 'beats',
    group: 'Tape stop',
    hint: 'How long the tape takes to come to a stop',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend of the stuttered sound with the original',
  }),
};
