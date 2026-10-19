import { p } from '@agstudio/sdk';

const TIMES = ['1/4', '1/8', '1/8d', '1/16', '1/4t', '1/8t'] as const;
export type DelayTime = (typeof TIMES)[number];

/** Length of each note value in beats (quarter notes). */
export const BEATS: Record<DelayTime, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8d': 0.75,
  '1/16': 0.25,
  '1/4t': 2 / 3,
  '1/8t': 1 / 3,
};

/** The Delay's knobs. */
export const delayParams = {
  time: p.enum(TIMES, '1/8', {
    label: 'Time',
    group: 'Delay',
    labels: {
      '1/4': '1/4',
      '1/8': '1/8',
      '1/8d': '1/8 dotted',
      '1/16': '1/16',
      '1/4t': '1/4 triplet',
      '1/8t': '1/8 triplet',
    },
    hint: 'Echo time, synced to the project tempo',
  }),
  feedback: p.float(0, 0.95, 0.4, {
    label: 'Feedback',
    unit: '%',
    group: 'Delay',
    hint: 'How much of each echo feeds the next one',
  }),
  pingPong: p.bool(false, { label: 'Ping-pong', group: 'Delay', hint: 'Echoes bounce between left and right' }),
  mix: p.float(0, 1, 0.3, { label: 'Mix', unit: '%', group: 'Delay' }),
  lowCut: p.float(20, 2000, 80, {
    label: 'Low cut',
    unit: 'Hz',
    scale: 'log',
    group: 'Echo tone',
    hint: 'Removes lows from the echoes (each repeat gets thinner)',
  }),
  highCut: p.float(1000, 20000, 9000, {
    label: 'High cut',
    unit: 'Hz',
    scale: 'log',
    group: 'Echo tone',
    hint: 'Removes highs from the echoes (each repeat gets darker)',
  }),
};
