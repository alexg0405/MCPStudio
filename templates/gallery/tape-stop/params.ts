import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (dsp.worklet.ts).
export const ID = 'user.tape-stop';

export const params = {
  stop: p.bool(false, {
    label: 'Stop',
    group: 'Tape',
    hint: 'On: the tape slows down to a stop. Off: it spins back up and the live sound returns. Automate it on a beat.',
  }),
  slowDown: p.float(0.05, 4, 0.8, {
    label: 'Slow down',
    unit: 's',
    scale: 'log',
    group: 'Tape',
    hint: 'How long the tape takes to come to a stop',
  }),
  spinUp: p.float(0.05, 3, 0.35, {
    label: 'Spin up',
    unit: 's',
    scale: 'log',
    group: 'Tape',
    hint: 'How long the tape takes to get back to full speed',
  }),
};
