import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition and the audio-thread kernel.
export const PLUCK_ID = 'agstudio.pluck';

export const pluckParams = {
  decay: p.float(0.1, 12, 2.5, {
    label: 'Decay',
    unit: 's',
    scale: 'log',
    hint: 'Time for a held note to fade by 60 dB',
  }),
  tone: p.float(0, 1, 0.6, { label: 'Tone', unit: '%', hint: 'Brightness of the pluck' }),
  damping: p.float(0, 1, 0.35, { label: 'Damping', unit: '%', hint: 'How quickly high harmonics die away' }),
  release: p.float(0.02, 3, 0.25, { label: 'Release', unit: 's', scale: 'log' }),
  width: p.float(0, 1, 0.5, { label: 'Width', unit: '%', hint: 'Stereo spread between voices' }),
  level: p.float(-36, 6, -6, { label: 'Level', unit: 'dB', scale: 'db' }),
};
