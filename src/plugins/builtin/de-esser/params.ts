import { p } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DE_ESSER_ID = 'agstudio.de-esser';

export const deEsserParams = {
  frequency: p.float(3000, 12000, 7000, {
    label: 'Frequency',
    unit: 'Hz',
    scale: 'log',
    group: 'Sibilance',
    hint: 'Where the harsh “s” and “t” sounds sit. Turn Listen on and sweep it until you hear only the hiss. Women and bright mics are often higher (7-9 kHz), men lower (5-7 kHz)',
  }),
  q: p.float(0.5, 6, 1.5, {
    label: 'Width (Q)',
    scale: 'log',
    group: 'Sibilance',
    hint: 'How narrow the band is: a high Q treats only a thin slice around the frequency, a low Q a broad stretch of the highs',
  }),
  threshold: p.float(-60, 0, -28, {
    label: 'Threshold',
    unit: 'dB',
    group: 'Sibilance',
    hint: 'How loud the hiss band must be before it is turned down. Lower it until the gain-reduction meter moves on the “s” sounds only',
  }),
  ratio: p.float(1.5, 20, 4, {
    label: 'Ratio',
    unit: 'x',
    scale: 'log',
    group: 'Sibilance',
    hint: 'How firmly it turns the hiss down once over the threshold: at 4x, 8 dB over comes out 2 dB over',
  }),
  range: p.float(0, 24, 10, {
    label: 'Range',
    unit: 'dB',
    group: 'Sibilance',
    hint: 'The most it ever turns the hiss down. A small range keeps it natural, a large one catches the worst “s” sounds',
  }),
  attack: p.float(0.05, 20, 1, {
    label: 'Attack',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast it turns the hiss down. Short catches the start of every “s”',
  }),
  release: p.float(5, 300, 40, {
    label: 'Release',
    unit: 'ms',
    scale: 'log',
    group: 'Timing',
    hint: 'How fast the highs come back after the “s” is over. Too long and the next word sounds dull',
  }),
  mode: p.enum(['split', 'wide'], 'split', {
    label: 'Mode',
    group: 'Output',
    labels: { split: 'Split band', wide: 'Wideband' },
    hint: 'Split band turns down only the hiss band and leaves the rest of the voice alone (natural). Wideband turns the whole voice down while an “s” plays (stronger, can dull the vowel)',
  }),
  listen: p.bool(false, {
    label: 'Listen',
    group: 'Output',
    hint: 'Plays only the band being watched, so you can hear what the de-esser hears and set the Frequency. Turn it off again before you bounce',
  }),
};
