import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (dsp.worklet.ts).
export const ID = '__PLUGIN_ID__';

export const params = {
  shape: p.float(0, 1, 0.5, { label: 'Shape', unit: '%', hint: 'Sine → saw' }),
  release: p.float(0.01, 4, 0.3, { label: 'Release', unit: 's', scale: 'log' }),
  level: p.float(-36, 6, -6, { label: 'Level', unit: 'dB', scale: 'db' }),
};
