import { p, type BoolSpec, type FloatSpec } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const MULTIBAND_ID = 'agstudio.multiband';

export const BANDS = ['low', 'mid', 'high'] as const;
export type BandName = (typeof BANDS)[number];

const NAMES: Record<BandName, string> = { low: 'Low', mid: 'Mid', high: 'High' };
const RANGE: Record<BandName, string> = {
  low: 'the lows (below the low crossover)',
  mid: 'the mids (between the crossovers)',
  high: 'the highs (above the high crossover)',
};

/** One band's compressor params: <band>Threshold, Ratio, Attack, Release, Gain, Solo, Bypass. */
function band<B extends BandName>(b: B) {
  const group = `${NAMES[b]} band`;
  const what = RANGE[b];
  return {
    [`${b}Threshold`]: p.float(-60, 0, 0, {
      label: `${NAMES[b]} threshold`,
      unit: 'dB',
      group,
      hint: `Level above which ${what} get turned down (0 dB = leave them alone)`,
    }),
    [`${b}Ratio`]: p.float(1, 20, 4, {
      label: `${NAMES[b]} ratio`,
      unit: 'x',
      scale: 'log',
      group,
      hint: 'How hard it turns down: at 4x, 4 dB over the threshold comes out 1 dB over',
    }),
    [`${b}Attack`]: p.float(0.5, 100, 10, {
      label: `${NAMES[b]} attack`,
      unit: 'ms',
      scale: 'log',
      group,
      hint: 'How fast it reacts once the band goes over: slower lets hits punch through',
    }),
    [`${b}Release`]: p.float(10, 1000, 150, {
      label: `${NAMES[b]} release`,
      unit: 'ms',
      scale: 'log',
      group,
      hint: 'How fast the band comes back up afterwards',
    }),
    [`${b}Gain`]: p.float(-24, 24, 0, {
      label: `${NAMES[b]} gain`,
      unit: 'dB',
      group,
      hint: `Turns ${what} up or down after compressing`,
    }),
    [`${b}Solo`]: p.bool(false, {
      label: `${NAMES[b]} solo`,
      group,
      hint: `Hear only ${what} (several bands can be soloed)`,
    }),
    [`${b}Bypass`]: p.bool(false, {
      label: `${NAMES[b]} bypass`,
      group,
      hint: `Lets ${what} through untouched (no compression, no gain)`,
    }),
  } as { [K in `${B}${'Threshold' | 'Ratio' | 'Attack' | 'Release' | 'Gain'}`]: FloatSpec } & {
    [K in `${B}${'Solo' | 'Bypass'}`]: BoolSpec;
  };
}

export const multibandParams = {
  lowFreq: p.float(40, 1000, 200, {
    label: 'Low crossover',
    unit: 'Hz',
    scale: 'log',
    group: 'Crossovers',
    hint: 'Where the low band ends and the mid band starts',
  }),
  highFreq: p.float(1000, 12000, 3000, {
    label: 'High crossover',
    unit: 'Hz',
    scale: 'log',
    group: 'Crossovers',
    hint: 'Where the mid band ends and the high band starts',
  }),
  ...band('low'),
  ...band('mid'),
  ...band('high'),
  output: p.float(-24, 12, 0, {
    label: 'Output',
    unit: 'dB',
    group: 'Output',
    hint: 'Overall level after the three bands are put back together',
  }),
};
