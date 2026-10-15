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

/** The drum kit each style plays (genre kits exist for trap, house, lo-fi and boom bap). */
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
};

/** Channel volumes of drum channels the writer makes, by drum (kick at the channel default). */
export const DRUM_VOLUME: Readonly<Record<KitSound, number>> = {
  kick: 0.78,
  snare: 0.74,
  clap: 0.72,
  hat: 0.52,
  'open-hat': 0.48,
  'tom-low': 0.66,
  'tom-mid': 0.66,
  'tom-high': 0.66,
  rim: 0.56,
  cowbell: 0.45,
  crash: 0.42,
};

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

// The building blocks (preset names exactly as the plugins define them).
const C = {
  classic808: { pluginId: BASS808_ID, preset: 'Classic 808', params: { drive: 0.35, glide: 0.1 }, volume: 0.62, rootKey: LOW },
  drill808: { pluginId: BASS808_ID, preset: 'Drill slide', volume: 0.58, rootKey: LOW },
  sub808: { pluginId: BASS808_ID, preset: 'Sub only', volume: 0.66, rootKey: LOW },
  punchy808: { pluginId: BASS808_ID, preset: 'Short punchy', volume: 0.6, rootKey: LOW },
  subBass: { pluginId: WAVETABLE_ID, preset: 'Deep sub bass', volume: 0.62, rootKey: LOW },
  pluckBass: { pluginId: THREE_OSC_ID, preset: 'Pluck bass', volume: 0.6, rootKey: LOW },
  supersaw: { pluginId: WAVETABLE_ID, preset: 'Warm supersaw pad', volume: 0.5 },
  darkPad: { pluginId: WAVETABLE_ID, preset: 'Warm supersaw pad', params: { cutoff: 1800 }, volume: 0.52 },
  glassPluck: { pluginId: WAVETABLE_ID, preset: 'Glassy pluck', volume: 0.5 },
  bellKeys: { pluginId: WAVETABLE_ID, preset: 'Bell keys', volume: 0.46 },
  softBellKeys: { pluginId: WAVETABLE_ID, preset: 'Bell keys', params: { cutoff: 3500 }, volume: 0.5 },
  strings: { pluginId: WAVETABLE_ID, preset: 'PWM strings', volume: 0.5 },
  darkStrings: { pluginId: WAVETABLE_ID, preset: 'PWM strings', params: { cutoff: 2500 }, volume: 0.52 },
  scream: { pluginId: WAVETABLE_ID, preset: 'Sync scream lead', volume: 0.46 },
  ep: { pluginId: FM_ID, preset: 'Electric piano (DX-style tine)', volume: 0.6 },
  mellowEp: { pluginId: FM_ID, preset: 'Electric piano (DX-style tine)', params: { cutoff: 3000 }, volume: 0.62 },
  bell: { pluginId: FM_ID, preset: 'Glassy FM bell', volume: 0.5 },
  brass: { pluginId: FM_ID, preset: 'Brass stab', volume: 0.5 },
  organ: { pluginId: FM_ID, preset: 'Drawbar organ (additive)', volume: 0.5 },
  marimba: { pluginId: FM_ID, preset: 'Marimba', volume: 0.55 },
  nylon: { pluginId: PLUCK_ID, preset: 'Nylon', volume: 0.58 },
  harp: { pluginId: PLUCK_ID, preset: 'Harp', volume: 0.5 },
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

const KIT_NAMES: Record<KitStyle, string> = { trap: 'trap kit', house: '909-style house kit', lofi: 'dusty lo-fi kit', boombap: 'boom bap kit' };

/** The palette in a few lines for the AI's prompt: per style, its kit and what each new track plays. */
export function paletteText(): string {
  const name = (c: SoundChoice) => `${PLUGIN_NAMES[c.pluginId] ?? c.pluginId} “${c.preset ?? 'init'}”`;
  return STYLES.map((style) => {
    const p = PALETTE[style];
    const parts = PITCHED_SOUNDS.map((sound) => `${sound} ${name(p[sound])}`);
    return `- ${STYLE_LABELS[style]} (${style}): ${KIT_NAMES[KIT_FOR[style]]}; ${parts.join(', ')}.`;
  }).join('\n');
}
