/**
 * What the mix setup builds, as data: each role bus's effects (exact plugin ids, preset names and
 * param ids of the built-ins), its fader and its sends, the reverb and delay returns by style, the
 * master chain, and channel levels by role. `setup.ts` applies it.
 */
import type { Role } from '@core/arrange/roles';
import type { Style } from '@core/beat/style';
import type { ParamValue } from '@agstudio/sdk';
import type { BusRole } from './layout';
import { VOCALS_BUS_FX, VOCALS_BUS_SENDS } from './vocal-chains';

// The plugin ids, FxRecipe and eqBands are shared with the vocal chains (`vocal-chains.ts`), which this file also uses.
export {
  COMPRESSOR,
  DELAY,
  DUCKER,
  EQ_PRO,
  LIMITER,
  MAXIMIZER,
  REVERB,
  SATURATOR,
  eqBands,
  type FxRecipe,
} from './recipe-parts';
import { COMPRESSOR, DELAY, DUCKER, EQ_PRO, LIMITER, MAXIMIZER, REVERB, SATURATOR, eqBands, type FxRecipe } from './recipe-parts';

export interface BusRecipe {
  fx: FxRecipe[];
  /** Fader in dB. */
  fader: number;
  /** Post-fader sends to the returns, in dB. */
  sends: Partial<Record<'reverb' | 'delay', number>>;
  color: string;
}

/** The mixer order of the buses (each takes the next free "Insert N"). */
export const BUS_ORDER: readonly BusRole[] = ['kick', 'drums', 'bass', 'chords', 'lead', 'vocals', 'fx', 'reverb', 'delay'];

/** The Chords and Lead buses' sweep targets: band 1 a high-pass, band 8 a low-pass at 20 kHz. */
export const SWEEP_BANDS: Readonly<Record<'chords' | 'lead', Record<string, ParamValue>>> = {
  chords: eqBands({ 1: { type: 'lowCut24', freq: 150 }, 8: { type: 'highCut24', freq: 20000 } }),
  lead: eqBands({ 1: { type: 'lowCut24', freq: 200 }, 8: { type: 'highCut24', freq: 20000 } }),
};

const REVERB_FOR: Record<Style, string> = {
  trap: 'Plate',
  drill: 'Plate',
  boombap: 'Room',
  lofi: 'Hall',
  house: 'Room',
  edm: 'Hall',
  reggaeton: 'Plate',
  afro: 'Room',
  pop: 'Plate',
  bigroom: 'Hall',
  proghouse: 'Hall',
  futurebass: 'Hall',
  dubstep: 'Plate',
  melodicdub: 'Hall',
  techhouse: 'Room',
  trance: 'Hall',
  dnb: 'Plate',
};

const DELAY_FOR: Record<Style, string> = {
  trap: 'Dotted ping-pong',
  drill: 'Dotted ping-pong',
  boombap: 'Eighth echo',
  lofi: 'Eighth echo',
  house: 'Dotted ping-pong',
  edm: 'Dotted ping-pong',
  reggaeton: 'Eighth echo',
  afro: 'Eighth echo',
  pop: 'Dotted ping-pong',
  bigroom: 'Dotted ping-pong',
  proghouse: 'Dotted ping-pong',
  futurebass: 'Triplet bounce',
  dubstep: 'Dub',
  melodicdub: 'Dotted ping-pong',
  techhouse: 'Eighth echo',
  trance: 'Dotted ping-pong',
  dnb: 'Eighth echo',
};

/** More reverb for the styles that live in it (dB added to the chords' and lead's sends). */
const REVERB_BOOST: Partial<Record<Style, number>> = { melodicdub: 4, futurebass: 2, proghouse: 2, trance: 2 };

/** Styles whose 808/bass doesn't duck under the kick (lo-fi: a breathing bass sounds wrong there). */
const NO_BASS_DUCK: ReadonlySet<Style> = new Set(['lofi']);
/** Styles whose chords pump harder with the kick. */
const PUMPING: ReadonlySet<Style> = new Set(['house', 'edm']);

/**
 * How the Chords bus ducks in the EDM pack: the sidechained pads of big room and trance, the 1/8 wobble of
 * future bass (a tempo pump: the volume dips on every 8th and swells back, with or without a kick), a
 * gentle breath for progressive and tech house and the dubstep styles.
 */
const CHORD_DUCK: Partial<Record<Style, { params: Record<string, ParamValue>; label: string }>> = {
  bigroom: { params: { depth: 0.7, threshold: -26, attack: 1, hold: 10, release: 200, curve: 0.4 }, label: 'sidechained pads: they pump with the kick' },
  trance: { params: { depth: 0.6, threshold: -26, attack: 1, hold: 10, release: 180, curve: 0.3 }, label: 'sidechained pads: they pump with the kick' },
  proghouse: { params: { depth: 0.45, threshold: -24, attack: 1, hold: 10, release: 220, curve: 0.3 }, label: 'a soft pump with the kick' },
  futurebass: {
    params: { mode: 'tempo', rate: '1/8', depth: 0.7, attack: 1, hold: 5, release: 190, curve: 0.45 },
    label: 'a 1/8 wobble: the chords dip and swell on every eighth note',
  },
  melodicdub: { params: { depth: 0.55, threshold: -24, attack: 1, hold: 10, release: 250, curve: 0.5 }, label: 'a slow pump with the kick' },
  techhouse: { params: { depth: 0.5, threshold: -24, attack: 1, hold: 10, release: 150, curve: 0.2 }, label: 'a tight pump with the kick' },
};

export function busRecipe(role: BusRole, style: Style): BusRecipe {
  switch (role) {
    case 'kick':
      return {
        fx: [
          {
            pluginId: EQ_PRO,
            label: 'EQ (30 Hz low cut, less box at 350 Hz, more click at 3.5 kHz)',
            params: eqBands({
              1: { type: 'lowCut24', freq: 30 },
              3: { type: 'bell', freq: 350, gain: -3, q: 1 },
              6: { type: 'bell', freq: 3500, gain: 2, q: 1 },
            }),
          },
        ],
        fader: 0,
        sends: {},
        color: '#c76b5b',
      };
    case 'drums': {
      const tape = style === 'boombap' || style === 'lofi';
      return {
        fx: [
          { pluginId: EQ_PRO, label: 'EQ (100 Hz low cut)', params: eqBands({ 1: { type: 'lowCut12', freq: 100 } }) },
          { pluginId: COMPRESSOR, preset: 'Gentle glue for a bus', label: 'glue compressor' },
          tape
            ? { pluginId: SATURATOR, preset: 'Tape warmth', params: { mix: 0.7 }, label: 'tape saturation' }
            : { pluginId: SATURATOR, preset: 'Subtle bus saturation', label: 'subtle saturation' },
        ],
        fader: -2,
        sends: {},
        color: '#c9a24a',
      };
    }
    case 'bass':
      return {
        fx: [
          { pluginId: EQ_PRO, label: 'EQ (28 Hz low cut)', params: eqBands({ 1: { type: 'lowCut24', freq: 28 } }) },
          ...(NO_BASS_DUCK.has(style)
            ? []
            : [{ pluginId: DUCKER, preset: 'Tight duck for bass', sidechain: 'kick', label: 'ducks under the kick' } as FxRecipe]),
        ],
        fader: -2,
        sends: {},
        color: '#9a72c2',
      };
    case 'chords':
      return {
        fx: [
          { pluginId: EQ_PRO, label: 'EQ (150 Hz high-pass, the low-pass open)', params: SWEEP_BANDS.chords },
          {
            pluginId: DUCKER,
            params:
              CHORD_DUCK[style]?.params ??
              (PUMPING.has(style)
                ? { depth: 0.5, threshold: -24, attack: 1, hold: 10, release: 200, curve: 0.3 }
                : { depth: 0.3, threshold: -24, attack: 1, hold: 10, release: 160, curve: 0 }),
            sidechain: 'kick',
            label: CHORD_DUCK[style]?.label ?? (PUMPING.has(style) ? 'pumps with the kick' : 'a light duck with the kick'),
          },
        ],
        fader: -6,
        sends: { reverb: -12 + (REVERB_BOOST[style] ?? 0) },
        color: '#4fa6a6',
      };
    case 'lead':
      return {
        fx: [
          {
            pluginId: EQ_PRO,
            label: 'EQ (200 Hz high-pass, +1.5 dB presence at 4.5 kHz)',
            params: { ...SWEEP_BANDS.lead, ...eqBands({ 6: { type: 'bell', freq: 4500, gain: 1.5, q: 1 } }) },
          },
        ],
        fader: -3,
        sends: { reverb: -14 + (REVERB_BOOST[style] ?? 0), delay: -18 },
        color: '#6aa86b',
      };
    case 'vocals':
      // The pop vocal chain's EQ, compressor and de-esser, and its sends: a voice sits in front of the lead.
      return { fx: [...VOCALS_BUS_FX], fader: -2, sends: { ...VOCALS_BUS_SENDS }, color: '#d1798b' };
    case 'fx':
      return {
        fx: [{ pluginId: EQ_PRO, label: 'EQ (30 Hz low cut)', params: eqBands({ 1: { type: 'lowCut24', freq: 30 } }) }],
        fader: -6,
        sends: { reverb: -10 },
        color: '#c77fa8',
      };
    case 'reverb':
      return {
        fx: [
          {
            pluginId: EQ_PRO,
            label: 'EQ (no lows below 250 Hz, darker above 9 kHz)',
            params: eqBands({ 1: { type: 'lowCut24', freq: 250 }, 8: { type: 'highCut12', freq: 9000 } }),
          },
          { pluginId: REVERB, preset: REVERB_FOR[style], params: { mix: 1 }, label: `${REVERB_FOR[style].toLowerCase()} reverb` },
        ],
        fader: 0,
        sends: {},
        color: '#5f8fbf',
      };
    case 'delay':
      return {
        fx: [
          {
            pluginId: DELAY,
            preset: DELAY_FOR[style],
            params: { mix: 1, lowCut: 300, highCut: 6000 },
            label: `${DELAY_FOR[style].toLowerCase()} delay`,
          },
        ],
        fader: 0,
        sends: {},
        color: '#6f7fd1',
      };
  }
}

/** The master chain, in order: EQ, tape saturation, and the Limiter last. */
export const MASTER_CHAIN: readonly FxRecipe[] = [
  {
    pluginId: EQ_PRO,
    label: 'EQ (25 Hz low cut, +1 dB air at 12 kHz)',
    params: eqBands({ 1: { type: 'lowCut24', freq: 25 }, 7: { type: 'highShelf', freq: 12000, gain: 1 } }),
  },
  { pluginId: SATURATOR, params: { mode: 'tape', drive: 2, mix: 0.5 }, label: 'tape saturation' },
  {
    pluginId: LIMITER,
    preset: 'Brickwall master −1 dB',
    params: { ceiling: -1, truePeak: true },
    label: 'Limiter (−1 dB ceiling, true peak)',
  },
];

/**
 * The Maximizer auto-level adds just before the master Limiter when a loudness is more than the Limiter gives cleanly (the
 * leveling sets its input and the soft clip's depth; its ceiling follows the Limiter's).
 */
export const MAXIMIZER_RECIPE: FxRecipe = {
  pluginId: MAXIMIZER,
  params: { ceiling: -1, clip: 2, knee: 3, release: 80 },
  label: 'Maximizer (limiter and soft clip on the peaks)',
};

/**
 * Channel volumes by role (linear; the channel default is 0.78) for channels nobody has set. The
 * drums match the beat writer's levels for the stock kit (`assistant/palette.ts` DRUM_VOLUME).
 */
export const ROLE_VOLUME: Readonly<Record<Role, number>> = {
  kick: 0.62,
  snare: 0.52,
  clap: 0.8,
  rim: 0.45,
  hat: 0.32,
  'open-hat': 0.22,
  perc: 0.4,
  tom: 0.5,
  crash: 0.3,
  kit: 0.62,
  '808': 0.62,
  bass: 0.62,
  chords: 0.55,
  pad: 0.5,
  keys: 0.58,
  lead: 0.55,
  pluck: 0.55,
  arp: 0.5,
  vox: 0.7,
  fx: 0.6,
  other: 0.78,
};
