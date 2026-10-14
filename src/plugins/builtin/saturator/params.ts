import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const SATURATOR_ID = 'agstudio.saturator';

export const MODES = ['tape', 'tube', 'clip'] as const;
export const OVERSAMPLING = ['2x', '4x'] as const;

export const saturatorParams = {
  mode: p.enum(MODES, 'tape', {
    label: 'Character',
    group: 'Saturation',
    labels: { tape: 'Tape (smooth, warm)', tube: 'Tube (rich, even harmonics)', clip: 'Hard clip (edgy, loud)' },
    hint: 'The kind of saturation: tape rounds peaks off smoothly, tube adds warm asymmetric harmonics, hard clip flattens them',
  }),
  drive: p.float(0, 36, 6, {
    label: 'Drive',
    unit: 'dB',
    group: 'Saturation',
    hint: 'How hard the sound is pushed into the saturation: more drive, more harmonics (the level is kept roughly even)',
  }),
  tone: p.float(-1, 1, 0, {
    label: 'Tone',
    unit: '%',
    group: 'Tone',
    hint: 'Tilts the sound after saturating: below 0% darker, above 0% brighter (±6 dB at the ends)',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend of the saturated sound with the clean one (parallel saturation)',
  }),
  output: p.float(-24, 12, 0, {
    label: 'Output',
    unit: 'dB',
    group: 'Output',
    hint: 'Overall level at the end',
  }),
  oversample: p.enum(OVERSAMPLING, '2x', {
    label: 'Quality',
    group: 'Output',
    labels: { '2x': '2× oversampling (lighter on CPU)', '4x': '4× oversampling (cleanest highs)' },
    hint: 'Runs the saturation at a higher rate so harsh aliasing doesn’t fold back into the highs',
  }),
};
