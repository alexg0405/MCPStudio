import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (dsp.worklet.ts).
export const ID = 'user.fm-bell';

export const params = {
  ratio: p.float(0.5, 12, 3.5, {
    label: 'Ratio',
    unit: 'x',
    group: 'Tone',
    hint: 'Pitch of the modulator against the note. Whole numbers sound like organs, odd fractions like bells (3.5, 5.4).',
  }),
  brightness: p.float(0, 8, 2.5, {
    label: 'Brightness',
    group: 'Tone',
    hint: 'How strongly the modulator bends the note: more is brighter and more metallic',
  }),
  ring: p.float(0.2, 10, 3, {
    label: 'Ring time',
    unit: 's',
    scale: 'log',
    group: 'Envelope',
    hint: 'How long the bell takes to fade by 60 dB (the bright part fades about twice as fast)',
  }),
  release: p.float(0.05, 4, 0.6, {
    label: 'Release',
    unit: 's',
    scale: 'log',
    group: 'Envelope',
    hint: 'How quickly the bell is damped when the key is let go',
  }),
  level: p.float(-36, 6, -6, { label: 'Level', unit: 'dB', scale: 'db', group: 'Output' }),
};
