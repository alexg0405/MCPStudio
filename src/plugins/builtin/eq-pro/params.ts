import { p, type BoolSpec, type EnumSpec, type FloatSpec } from '@agstudio/sdk/params';
import { BAND_TYPES, type BandType } from './design.kernel';

// Shared by the main-thread definition (index.ts), the editor and the audio-thread kernel (kernel.ts).
export const EQ_PRO_ID = 'agstudio.eq-pro';
export const BAND_COUNT = 8;

export const TYPE_LABELS: Record<BandType, string> = {
  bell: 'Bell',
  lowShelf: 'Low shelf',
  highShelf: 'High shelf',
  lowCut12: 'Low cut 12 dB/oct',
  lowCut24: 'Low cut 24 dB/oct',
  lowCut48: 'Low cut 48 dB/oct',
  highCut12: 'High cut 12 dB/oct',
  highCut24: 'High cut 24 dB/oct',
  highCut48: 'High cut 48 dB/oct',
  notch: 'Notch',
};

/** Where the bands start (all off): FL's Parametric EQ 2 layout, lows on the left. */
const LAYOUT: readonly { type: BandType; freq: number; q: number }[] = [
  { type: 'lowCut24', freq: 30, q: Math.SQRT1_2 },
  { type: 'lowShelf', freq: 100, q: Math.SQRT1_2 },
  { type: 'bell', freq: 250, q: 1 },
  { type: 'bell', freq: 700, q: 1 },
  { type: 'bell', freq: 1800, q: 1 },
  { type: 'bell', freq: 4500, q: 1 },
  { type: 'highShelf', freq: 10000, q: Math.SQRT1_2 },
  { type: 'highCut24', freq: 18000, q: Math.SQRT1_2 },
];

export interface BandParams {
  on: BoolSpec;
  type: EnumSpec<BandType>;
  freq: FloatSpec;
  gain: FloatSpec;
  q: FloatSpec;
}

/** Param ids of band `b` (1–8). */
export const bandIds = (b: number) =>
  ({ on: `b${b}On`, type: `b${b}Type`, freq: `b${b}Freq`, gain: `b${b}Gain`, q: `b${b}Q` }) as const;

function band(b: number): Record<string, BoolSpec | EnumSpec<BandType> | FloatSpec> {
  const at = LAYOUT[b - 1] as (typeof LAYOUT)[number];
  const group = `Band ${b}`;
  const ids = bandIds(b);
  return {
    [ids.on]: p.bool(false, { label: `Band ${b} on`, group, hint: `Switches band ${b} on or off` }),
    [ids.type]: p.enum(BAND_TYPES, at.type, {
      label: `Band ${b} type`,
      group,
      labels: TYPE_LABELS,
      hint: 'Bell lifts or dips around the frequency, shelves tilt everything below/above it, cuts remove everything beyond it, notch removes a thin slice',
    }),
    [ids.freq]: p.float(20, 20000, at.freq, {
      label: `Band ${b} frequency`,
      unit: 'Hz',
      scale: 'log',
      group,
      hint: `Where band ${b} acts`,
    }),
    [ids.gain]: p.float(-24, 24, 0, {
      label: `Band ${b} gain`,
      unit: 'dB',
      group,
      hint: `How much band ${b} lifts (+) or dips (−); bells and shelves only`,
    }),
    [ids.q]: p.float(0.1, 18, at.q, {
      label: `Band ${b} Q`,
      scale: 'log',
      group,
      hint: 'How narrow the band is: low Q is broad and gentle, high Q is narrow (on cuts it adds a resonant bump)',
    }),
  };
}

function allBands() {
  const out: Record<string, BoolSpec | EnumSpec<BandType> | FloatSpec> = {};
  for (let b = 1; b <= BAND_COUNT; b++) Object.assign(out, band(b));
  return out;
}

type BandKey = `b${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
type Bands = { [K in BandKey as `${K}On`]: BoolSpec } & { [K in BandKey as `${K}Type`]: EnumSpec<BandType> } & {
  [K in BandKey as `${K}Freq` | `${K}Gain` | `${K}Q`]: FloatSpec;
};

export const eqProParams = {
  ...(allBands() as Bands),
  output: p.float(-24, 12, 0, {
    label: 'Output',
    unit: 'dB',
    group: 'Output',
    hint: 'Overall level after the EQ (turn down after big boosts)',
  }),
};
