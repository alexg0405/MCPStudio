import { p, type ParamSpec } from '@agstudio/sdk/params';

// Shared by the main-thread definition (index.ts) and the audio-thread kernel (kernel.ts).
export const DRUM_PADS_ID = 'agstudio.drum-pads';

export const PADS = 16;
/** Pad 1 plays on key 36 (C3 in FL's naming), pad 16 on key 51. */
export const FIRST_KEY = 36;

/** Built-in sounds a pad plays while it has no sample (synthesized when the plugin loads). */
export const SOUNDS = [
  ['kick', 'Kick'],
  ['kick808', '808 kick (long)'],
  ['kickHard', 'Hard kick'],
  ['snare', 'Snare'],
  ['snare2', 'Tight snare'],
  ['rim', 'Rim / side stick'],
  ['clap', 'Clap'],
  ['snap', 'Finger snap'],
  ['hatClosed', 'Closed hat'],
  ['hatPedal', 'Pedal hat'],
  ['hatOpen', 'Open hat'],
  ['crash', 'Crash'],
  ['ride', 'Ride'],
  ['tomLow', 'Low tom'],
  ['tomMid', 'Mid tom'],
  ['tomHigh', 'High tom'],
  ['cowbell', 'Cowbell'],
  ['clave', 'Clave'],
  ['shaker', 'Shaker'],
  ['conga', 'Conga'],
  ['none', 'Nothing'],
] as const;

export type SoundId = (typeof SOUNDS)[number][0];
export const SOUND_IDS: readonly SoundId[] = SOUNDS.map(([id]) => id);
export const SOUND_LABELS = Object.fromEntries(SOUNDS) as Record<SoundId, string>;

/** The default kit: the General MIDI drum map from key 36 to 51 (hats in choke group 1). */
export const GM_KIT: readonly { sound: SoundId; tune?: number; choke?: number }[] = [
  { sound: 'kick' }, //       36 bass drum
  { sound: 'rim' }, //        37 side stick
  { sound: 'snare' }, //      38 snare
  { sound: 'clap' }, //       39 hand clap
  { sound: 'snare2' }, //     40 electric snare
  { sound: 'tomLow', tune: -2 }, // 41 low floor tom
  { sound: 'hatClosed', choke: 1 }, // 42 closed hi-hat
  { sound: 'tomLow', tune: 1 }, //  43 high floor tom
  { sound: 'hatPedal', choke: 1 }, // 44 pedal hi-hat
  { sound: 'tomMid', tune: -2 }, // 45 low tom
  { sound: 'hatOpen', choke: 1 }, //  46 open hi-hat
  { sound: 'tomMid', tune: 1 }, //  47 low-mid tom
  { sound: 'tomHigh', tune: -1 }, // 48 hi-mid tom
  { sound: 'crash' }, //      49 crash
  { sound: 'tomHigh', tune: 2 }, // 50 high tom
  { sound: 'ride' }, //       51 ride
];

/** Param ids of pad `n` (1–16). */
export const padParam = (n: number) =>
  ({
    sound: `pad${n}Sound`,
    tune: `pad${n}Tune`,
    level: `pad${n}Level`,
    pan: `pad${n}Pan`,
    decay: `pad${n}Decay`,
    reverse: `pad${n}Reverse`,
    choke: `pad${n}Choke`,
  }) as const;

/** Decay at or above this plays the whole sound (no fade). */
export const FULL_DECAY = 10;

/**
 * Per-pad settings apply when a pad is hit, so they aren't automatable: that keeps them off
 * AudioParams (16 pads × 7 settings would cost the browser time every block, playing or not).
 */
function padSpecs(n: number): Record<string, ParamSpec> {
  const kit = GM_KIT[n - 1] ?? { sound: 'none' as SoundId };
  const id = padParam(n);
  const group = `Pad ${n}`;
  const automatable = false;
  return {
    [id.sound]: p.enum(SOUND_IDS, kit.sound, {
      label: `Pad ${n} sound`,
      labels: SOUND_LABELS,
      group,
      hint: 'The built-in sound the pad plays while it has no sample',
    }),
    [id.tune]: p.float(-24, 24, kit.tune ?? 0, {
      label: `Pad ${n} tune`,
      unit: 'st',
      group,
      automatable,
      hint: 'Pitch up or down in semitones (like a sampler: higher is also shorter)',
    }),
    [id.level]: p.float(-36, 6, 0, {
      label: `Pad ${n} level`,
      unit: 'dB',
      scale: 'db',
      group,
      automatable,
      hint: 'How loud the pad is',
    }),
    [id.pan]: p.float(-1, 1, 0, { label: `Pad ${n} pan`, group, automatable, hint: 'Left (−1) to right (+1)' }),
    [id.decay]: p.float(0.02, FULL_DECAY, FULL_DECAY, {
      label: `Pad ${n} decay`,
      unit: 's',
      scale: 'log',
      group,
      automatable,
      hint: 'Fades the hit out over this time; at the maximum the whole sound plays',
    }),
    [id.reverse]: p.bool(false, { label: `Pad ${n} reverse`, group, hint: 'Plays the sound backwards' }),
    [id.choke]: p.int(0, 4, kit.choke ?? 0, {
      label: `Pad ${n} choke group`,
      group,
      automatable,
      hint: 'Pads in the same group (1–4) cut each other off, like closed and open hats; 0 = none',
    }),
  };
}

const pads: Record<string, ParamSpec> = {};
for (let n = 1; n <= PADS; n++) Object.assign(pads, padSpecs(n));

export const drumPadsParams: Record<string, ParamSpec> = {
  ...pads,
  velocity: p.float(0, 1, 0.8, {
    label: 'Velocity',
    unit: '%',
    group: 'Kit',
    hint: 'How much harder hits play louder (0% = every hit the same)',
  }),
  level: p.float(-36, 6, -3, { label: 'Volume', unit: 'dB', scale: 'db', group: 'Kit', hint: 'Overall level' }),
};

/** The sample slot of pad `n` (1–16). */
export const padSlot = (n: number) => `pad${n}`;
export const PAD_SLOTS: readonly string[] = Array.from({ length: PADS }, (_, i) => padSlot(i + 1));
