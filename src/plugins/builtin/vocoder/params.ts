import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const VOCODER_ID = 'agstudio.vocoder';

export const BAND_COUNTS = ['16', '24', '32'] as const;

export const vocoderParams = {
  bands: p.enum(BAND_COUNTS, '24', {
    label: 'Bands',
    group: 'Bands',
    labels: { '16': '16 bands (punchy, robotic)', '24': '24 bands', '32': '32 bands (clearest words)' },
    hint: 'How many frequency bands the voice is split into: more bands, clearer words',
  }),
  width: p.float(0.25, 2, 1, {
    label: 'Band width',
    unit: 'x',
    scale: 'log',
    group: 'Bands',
    hint: 'How wide each band is: below 1x thin and whistling, above 1x smooth and blurry',
  }),
  formant: p.float(-12, 12, 0, {
    label: 'Formant',
    unit: 'st',
    group: 'Voice',
    hint: 'Shifts the voice character: lower sounds bigger and deeper, higher smaller and brighter',
  }),
  attack: p.float(0.5, 50, 4, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Envelope',
    hint: 'How fast the bands follow the voice getting louder: short is crisp, long is soft',
  }),
  release: p.float(5, 500, 50, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Envelope',
    hint: 'How fast the bands let go when the voice gets quieter: long smears words together',
  }),
  sibilance: p.float(0, 1, 0.3, {
    label: 'Sibilance',
    unit: '%',
    group: 'Voice',
    hint: 'Lets the voice’s own “s” and “t” sounds through, so words stay clear',
  }),
  noise: p.float(0, 1, 0.1, {
    label: 'Noise',
    unit: '%',
    group: 'Voice',
    hint: 'Adds noise to the synth so breathy and whispered sounds come through',
  }),
  mix: p.float(0, 1, 1, {
    label: 'Mix',
    unit: '%',
    group: 'Output',
    hint: 'Blend of the vocoded sound with the plain synth',
  }),
  output: p.float(-24, 12, 0, {
    label: 'Output',
    unit: 'dB',
    group: 'Output',
    hint: 'Overall level at the end',
  }),
};
