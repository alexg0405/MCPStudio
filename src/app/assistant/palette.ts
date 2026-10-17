/**
 * The sound palette of each style: which instrument and preset plays a beat's 808, bass, keys,
 * pads, leads… at a channel volume that sits in the mix, and which drum kit its drums use. The beat
 * writer builds new channels from it; the AI reads it (`paletteText`) so it knows what each sound
 * will be, and can pick another one by preset name.
 */
import type { BeatSound } from '@core/beat/spec';
import { STYLE_LABELS, STYLES, type Style } from '@core/beat/style';
import type { KitSound, KitStyle } from '@core/model/kit';
import type { ParamValue } from '@agstudio/sdk';

/** One way to play a sound: an instrument, a preset of it, extra settings and a channel level. */
export interface SoundChoice {
  pluginId: string;
  preset?: string;
  params?: Record<string, ParamValue>;
  /** Channel volume (linear gain; 0.78 is a new channel's default). */
  volume: number;
  /** The key a channel-rack step plays (pitched channels). */
  rootKey?: number;
}

export type PitchedSound = Exclude<BeatSound, KitSound>;
export const PITCHED_SOUNDS: readonly PitchedSound[] = ['808', 'bass', 'lead', 'pad', 'pluck', 'keys', 'bell', 'strings'];

export const BASS808_ID = 'agstudio.bass808';
export const THREE_OSC_ID = 'agstudio.3xosc';
export const PLUCK_ID = 'agstudio.pluck';
export const WAVETABLE_ID = 'agstudio.wavetable';
export const FM_ID = 'agstudio.fm';

/** The drum kit each style plays (genre kits: trap, house, lo-fi, boom bap, festival, bass music, drum & bass). */
export const KIT_FOR: Readonly<Record<Style, KitStyle>> = {
  trap: 'trap',
  drill: 'trap',
  boombap: 'boombap',
  lofi: 'lofi',
  house: 'house',
  edm: 'house',
  reggaeton: 'trap',
  afro: 'house',
  pop: 'trap',
  bigroom: 'edm',
  proghouse: 'house',
  futurebass: 'bass',
  dubstep: 'bass',
  melodicdub: 'bass',
  techhouse: 'house',
  trance: 'edm',
  dnb: 'dnb',
};

/**
 * Channel volumes of the drum channels the writer sets up, for the stock kit: in a beat the snare
 * and clap sit about 4 dB under the kick (LUFS), closed hats 11 dB, open hats 12 dB. The kick is
 * at −4 dB, so the rest of the beat has room around it.
 */
export const DRUM_VOLUME: Readonly<Record<KitSound, number>> = {
  kick: 0.62,
  snare: 0.52,
  clap: 0.8,
  hat: 0.32,
  'open-hat': 0.22,
  'tom-low': 0.5,
  'tom-mid': 0.5,
  'tom-high': 0.5,
  rim: 0.45,
  cowbell: 0.35,
  crash: 0.3,
};

/**
 * How much louder (dB) each genre kit's piece is than the stock one, played in a beat (measured:
 * the samples' peaks match, their density doesn't). Its channel makes up for it.
 */
const KIT_LOUDNESS: Readonly<Record<KitStyle, Partial<Record<KitSound, number>>>> = {
  trap: { kick: 2.2, snare: -3.5, clap: -0.6, hat: -8, 'open-hat': -3.6 },
  house: { kick: 2.2, snare: -2.4, clap: 1.9, hat: -5.9, 'open-hat': -2.5 },
  // Lo-fi and boom bap kicks sit 2 dB further back: their drum bus leads (0 to −2 dB under the kick).
  lofi: { kick: 4.6, snare: -4, clap: 1.1, hat: -4.8, 'open-hat': -3.3 },
  boombap: { kick: 5.3, snare: -3, clap: 0.9, hat: -4.6, 'open-hat': -2.9 },
  // The EDM pack's kits, measured the same way (one bar of each piece through the writer's channel, LUFS vs the stock piece).
  edm: { kick: 2.2, snare: -2.7, clap: 0.3, hat: -5.5, 'open-hat': -3.1 },
  bass: { kick: 1.5, snare: -3.7, clap: 0.2, hat: -7.9, 'open-hat': -2.9 },
  dnb: { kick: 0.7, snare: -2.2, clap: -0.3, hat: -5.3, 'open-hat': -5.1 },
};

/** The channel volume for a drum of a kit (none: the stock kit). */
export function drumVolume(sound: KitSound, kit?: KitStyle | null): number {
  const db = kit ? (KIT_LOUDNESS[kit][sound] ?? 0) : 0;
  return Math.round(Math.min(1.25, DRUM_VOLUME[sound] * Math.pow(10, -db / 20)) * 1000) / 1000;
}

/** 3xOsc settings for each pitched sound, when the palette's instrument isn't installed. */
export const SYNTH: Readonly<Record<PitchedSound, Record<string, number | string>>> = {
  bass: { osc1Coarse: -12, osc2Coarse: -12, attack: 0.002, decay: 0.25, sustain: 0.3, cutoff: 600, filterEnv: 2.5 },
  lead: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.25, cutoff: 3200, osc3Level: 0.2 },
  pad: { attack: 0.6, decay: 1.2, sustain: 0.8, release: 1.5, cutoff: 1800, filterEnv: 0.6, osc3Level: 0.2 },
  pluck: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.3, cutoff: 2600, filterEnv: 2 },
  keys: { osc1Wave: 'triangle', attack: 0.004, decay: 1.2, sustain: 0.25, release: 0.4, cutoff: 2400 },
  bell: { osc1Wave: 'sine', osc2Coarse: 12, attack: 0.002, decay: 1.6, sustain: 0, release: 1, cutoff: 6000 },
  strings: { attack: 0.35, decay: 0.8, sustain: 0.85, release: 0.9, cutoff: 2600, filterEnv: 0.3 },
  '808': {
    osc1Wave: 'sine',
    osc2Level: 0,
    osc3Wave: 'sine',
    osc3Coarse: 0,
    osc3Level: 0,
    attack: 0.002,
    decay: 2,
    sustain: 0.2,
    release: 0.15,
    cutoff: 900,
    filterEnv: 0,
  },
};

const LOW = 36;

/*
 * The building blocks (preset names exactly as the plugins define them). Levels (the instrument's
 * own `level` and the channel volume) are set from offline renders (test/browser/palette.test.ts)
 * so that each sound, alone, sits about this far under a kit kick at the default channel volume:
 * 808 −3 dB, bass −4, lead and keys and pad −8, pluck, bell and strings −9 (lo-fi's keys −3 and
 * pad −6: they lead the mix there). The writer's drum levels put the kick 4–5 dB lower, so in a beat
 * everything sits a little louder than that around it; auto-level then balances the buses per style.
 */
const C = {
  classic808: { pluginId: BASS808_ID, preset: 'Classic 808', params: { drive: 0.35, glide: 0.1 }, volume: 0.81, rootKey: LOW },
  drill808: { pluginId: BASS808_ID, preset: 'Drill slide', volume: 0.55, rootKey: LOW },
  sub808: { pluginId: BASS808_ID, preset: 'Sub only', volume: 0.76, rootKey: LOW },
  punchy808: { pluginId: BASS808_ID, preset: 'Short punchy', params: { level: 3 }, volume: 0.82, rootKey: LOW },
  subBass: { pluginId: WAVETABLE_ID, preset: 'Deep sub bass', params: { level: 0 }, volume: 0.79, rootKey: LOW },
  pluckBass: { pluginId: THREE_OSC_ID, preset: 'Pluck bass', params: { level: 6 }, volume: 0.7, rootKey: LOW },
  supersaw: { pluginId: WAVETABLE_ID, preset: 'Warm supersaw pad', params: { level: -5 }, volume: 0.51 },
  darkPad: { pluginId: WAVETABLE_ID, preset: 'Warm supersaw pad', params: { cutoff: 1800, level: -3 }, volume: 0.54 },
  glassPluck: { pluginId: WAVETABLE_ID, preset: 'Glassy pluck', params: { level: 6 }, volume: 0.71 },
  bellKeys: { pluginId: WAVETABLE_ID, preset: 'Bell keys', params: { level: 5 }, volume: 0.47 },
  softBellKeys: { pluginId: WAVETABLE_ID, preset: 'Bell keys', params: { cutoff: 3500, level: 5 }, volume: 0.52 },
  strings: { pluginId: WAVETABLE_ID, preset: 'PWM strings', volume: 0.55 },
  darkStrings: { pluginId: WAVETABLE_ID, preset: 'PWM strings', params: { cutoff: 2500 }, volume: 0.55 },
  scream: { pluginId: WAVETABLE_ID, preset: 'Sync scream lead', volume: 0.59 },
  ep: { pluginId: FM_ID, preset: 'Electric piano (DX-style tine)', params: { level: -4 }, volume: 0.63 },
  mellowEp: { pluginId: FM_ID, preset: 'Electric piano (DX-style tine)', params: { cutoff: 3000, level: 1 }, volume: 0.64 },
  bell: { pluginId: FM_ID, preset: 'Glassy FM bell', params: { level: 3 }, volume: 0.5 },
  brass: { pluginId: FM_ID, preset: 'Brass stab', params: { level: -3 }, volume: 0.48 },
  organ: { pluginId: FM_ID, preset: 'Drawbar organ (additive)', params: { level: -3 }, volume: 0.52 },
  marimba: { pluginId: FM_ID, preset: 'Marimba', params: { level: 6 }, volume: 0.82 },
  nylon: { pluginId: PLUCK_ID, preset: 'Nylon', params: { level: 0 }, volume: 0.98 },
  harp: { pluginId: PLUCK_ID, preset: 'Harp', params: { level: 0 }, volume: 0.63 },
  // The EDM pack (presets in plugins/builtin/wavetable and fm; levels from the palette test).
  bigRoomLead: { pluginId: WAVETABLE_ID, preset: 'Big room lead', volume: 0.55 },
  supersawStack: { pluginId: WAVETABLE_ID, preset: 'Supersaw stack', volume: 0.55 },
  futureChord: { pluginId: WAVETABLE_ID, preset: 'Future bass chord', volume: 0.55 },
  growl: { pluginId: WAVETABLE_ID, preset: 'Growl bass', volume: 0.7, rootKey: LOW },
  riddim: { pluginId: WAVETABLE_ID, preset: 'Riddim wobble', volume: 0.7, rootKey: LOW },
  reese: { pluginId: WAVETABLE_ID, preset: 'Reese bass', volume: 0.7, rootKey: LOW },
  techBass: { pluginId: WAVETABLE_ID, preset: 'Tech house bass', volume: 0.7, rootKey: LOW },
  rollingBass: { pluginId: WAVETABLE_ID, preset: 'Rolling bass', volume: 0.7, rootKey: LOW },
  trancePluck: { pluginId: WAVETABLE_ID, preset: 'Trance pluck', volume: 0.93 },
  gatedSaw: { pluginId: WAVETABLE_ID, preset: 'Gated supersaw', volume: 0.55 },
  progPluck: { pluginId: WAVETABLE_ID, preset: 'Prog pluck', volume: 0.9 },
  vocalChop: { pluginId: WAVETABLE_ID, preset: 'Vocal chop', volume: 0.6 },
  softPiano: { pluginId: FM_ID, preset: 'Soft piano (felt, long decay)', volume: 0.6 },
  brightPiano: { pluginId: FM_ID, preset: 'Bright piano (club stabs)', volume: 0.6 },
} satisfies Record<string, SoundChoice>;

type Palette = Record<PitchedSound, SoundChoice>;

/** Each style's sounds (the first choice; the writer falls back to 3xOsc when a plugin is missing). */
export const PALETTE: Readonly<Record<Style, Palette>> = {
  trap: {
    '808': C.classic808,
    bass: C.subBass,
    lead: C.glassPluck,
    pad: C.supersaw,
    pluck: C.harp,
    keys: C.ep,
    bell: C.bell,
    strings: C.strings,
  },
  drill: {
    '808': C.drill808,
    bass: C.subBass,
    lead: C.bellKeys,
    pad: C.darkStrings,
    pluck: C.nylon,
    keys: C.ep,
    bell: C.bell,
    strings: C.darkStrings,
  },
  boombap: {
    '808': C.sub808,
    bass: C.subBass,
    lead: C.bellKeys,
    pad: C.darkStrings,
    pluck: C.nylon,
    keys: C.ep,
    bell: C.bell,
    strings: C.strings,
  },
  lofi: {
    '808': C.sub808,
    bass: C.subBass,
    lead: C.softBellKeys,
    pad: C.darkPad,
    pluck: C.nylon,
    keys: C.mellowEp,
    bell: C.bell,
    strings: C.darkStrings,
  },
  house: {
    '808': C.punchy808,
    bass: C.pluckBass,
    lead: C.glassPluck,
    pad: C.supersaw,
    pluck: C.glassPluck,
    keys: C.organ,
    bell: C.bell,
    strings: C.strings,
  },
  edm: {
    '808': C.classic808,
    bass: C.subBass,
    lead: C.scream,
    pad: C.supersaw,
    pluck: C.glassPluck,
    keys: C.brass,
    bell: C.bell,
    strings: C.strings,
  },
  reggaeton: {
    '808': C.classic808,
    bass: C.subBass,
    lead: C.marimba,
    pad: C.supersaw,
    pluck: C.marimba,
    keys: C.ep,
    bell: C.bell,
    strings: C.strings,
  },
  afro: {
    '808': C.classic808,
    bass: C.subBass,
    lead: C.marimba,
    pad: C.supersaw,
    pluck: C.nylon,
    keys: C.ep,
    bell: C.bell,
    strings: C.strings,
  },
  pop: {
    '808': C.classic808,
    bass: C.subBass,
    lead: C.glassPluck,
    pad: C.supersaw,
    pluck: C.glassPluck,
    keys: C.ep,
    bell: C.bell,
    strings: C.strings,
  },
  bigroom: {
    '808': C.punchy808,
    bass: C.subBass,
    lead: C.bigRoomLead,
    pad: C.supersawStack,
    pluck: C.glassPluck,
    keys: C.brightPiano,
    bell: C.bell,
    strings: C.strings,
  },
  proghouse: {
    '808': C.punchy808,
    bass: C.rollingBass,
    lead: C.progPluck,
    pad: C.supersaw,
    pluck: C.progPluck,
    keys: C.softPiano,
    bell: C.bell,
    strings: C.strings,
  },
  futurebass: {
    '808': C.sub808,
    bass: C.subBass,
    lead: C.vocalChop,
    pad: C.futureChord,
    pluck: C.glassPluck,
    keys: C.softPiano,
    bell: C.bell,
    strings: C.strings,
  },
  dubstep: {
    '808': C.sub808,
    bass: C.growl,
    lead: C.scream,
    pad: C.darkPad,
    pluck: C.glassPluck,
    keys: C.ep,
    bell: C.bell,
    strings: C.darkStrings,
  },
  melodicdub: {
    '808': C.sub808,
    bass: C.subBass,
    lead: C.vocalChop,
    pad: C.supersawStack,
    pluck: C.glassPluck,
    keys: C.softPiano,
    bell: C.bell,
    strings: C.strings,
  },
  techhouse: {
    '808': C.punchy808,
    bass: C.techBass,
    lead: C.vocalChop,
    pad: C.darkPad,
    pluck: C.glassPluck,
    keys: C.brightPiano,
    bell: C.bell,
    strings: C.darkStrings,
  },
  trance: {
    '808': C.punchy808,
    bass: C.rollingBass,
    lead: C.bigRoomLead,
    pad: C.gatedSaw,
    pluck: C.trancePluck,
    keys: C.softPiano,
    bell: C.bell,
    strings: C.strings,
  },
  dnb: {
    '808': C.sub808,
    bass: C.reese,
    lead: C.vocalChop,
    pad: C.darkPad,
    pluck: C.progPluck,
    keys: C.softPiano,
    bell: C.bell,
    strings: C.strings,
  },
};

/**
 * Other sounds a style is known for, offered to the AI by preset name (a track's `preset` plays on
 * them): dubstep's riddim wobble, drum & bass's neuro growl. Calibrated like the palette.
 */
export const ALTERNATES: Readonly<Partial<Record<Style, Partial<Record<PitchedSound, SoundChoice>>>>> = {
  dubstep: { bass: C.riddim },
  dnb: { bass: C.growl },
};

/** A pitched sound on 3xOsc: what plays when the palette's plugin isn't installed. */
function synth(sound: PitchedSound): SoundChoice {
  const low = sound === '808' || sound === 'bass';
  const volume = low ? 0.62 : sound === 'pad' || sound === 'strings' ? 0.45 : 0.55;
  return { pluginId: THREE_OSC_ID, params: SYNTH[sound], volume, ...(low ? { rootKey: LOW } : {}) };
}

export const isPitched = (sound: BeatSound): sound is PitchedSound => (PITCHED_SOUNDS as readonly string[]).includes(sound);

/**
 * How a style plays a sound, best first: the palette's choice, then backups for when its plugin
 * isn't installed (the Pluck for plucks, then 3xOsc settings). Drums have none: they are kit
 * samples (`KIT_FOR`). Without a style, the pop palette.
 */
export function soundFor(style: Style | null, sound: BeatSound): SoundChoice[] {
  if (!isPitched(sound)) return [];
  const first = PALETTE[style ?? 'pop'][sound];
  const backups: SoundChoice[] = sound === 'pluck' ? [{ pluginId: PLUCK_ID, volume: 0.6 }, synth(sound)] : [synth(sound)];
  return [first, ...backups.filter((b) => b.pluginId !== first.pluginId)];
}

const PLUGIN_NAMES: Record<string, string> = {
  [BASS808_ID]: '808 Bass',
  [WAVETABLE_ID]: 'Wavetable',
  [FM_ID]: 'FM',
  [THREE_OSC_ID]: '3xOsc',
  [PLUCK_ID]: 'Pluck',
};

const KIT_NAMES: Record<KitStyle, string> = {
  trap: 'trap kit',
  house: '909-style house kit',
  lofi: 'dusty lo-fi kit',
  boombap: 'boom bap kit',
  edm: 'festival kit (tight clicky kick, bright snare)',
  bass: 'bass-music kit (short sub kick, big dark snare)',
  dnb: 'drum & bass kit (tight kick, cracking snare)',
};

/** The palette in a few lines for the AI's prompt: per style, its kit and what each new track plays. */
export function paletteText(): string {
  const name = (c: SoundChoice) => `${PLUGIN_NAMES[c.pluginId] ?? c.pluginId} “${c.preset ?? 'init'}”`;
  return STYLES.map((style) => {
    const p = PALETTE[style];
    const parts = PITCHED_SOUNDS.map((sound) => `${sound} ${name(p[sound])}`);
    const alt = Object.entries(ALTERNATES[style] ?? {}).map(([sound, c]) => `${sound} ${name(c)}`);
    return `- ${STYLE_LABELS[style]} (${style}): ${KIT_NAMES[KIT_FOR[style]]}; ${parts.join(', ')}${alt.length ? `; also (set preset): ${alt.join(', ')}` : ''}.`;
  }).join('\n');
}
