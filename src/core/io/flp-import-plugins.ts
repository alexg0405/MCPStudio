/**
 * Which built-in plugin plays in place of an FL plugin. FL plugin settings are not read, so this is a
 * guess from names: FL's own generators and effects have a table, VST/AU plugins are guessed from their
 * names, and a channel named after a drum sound gets that sound from the built-in kit.
 */
import type { ParamValue } from '@agstudio/sdk/params';
import type { FlpChannel, FlpSlot, FlpVst } from './flp';
import { FLP_PLUGIN } from './flp-import-types';

/** The built-in a generator maps to. */
export interface PluginChoice {
  pluginId: string;
  /** A built-in kit sound to load into a sampler stand-in. */
  kit?: string;
  params?: Record<string, ParamValue>;
  /** False when the built-in is FL's own plugin's counterpart (no "stand-in" label). */
  standIn: boolean;
}

/** 3x Osc settings that make it sound like an electric piano (stands in for FL Keys and piano VSTs). */
const KEYS_3XOSC: Record<string, ParamValue> = {
  osc1Wave: 'triangle',
  osc2Wave: 'sine',
  osc2Level: 0.4,
  attack: 0.003,
  decay: 0.9,
  sustain: 0.25,
  release: 0.4,
  cutoff: 3500,
  filterEnv: 0.8,
};

/** A single drum sound named in a channel name → kit generator. */
export function kitFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/open ?h(i ?)?hat|\boh\b|hat ?open/.test(lower)) return 'kit/hat-open';
  if (/h(i ?)?hat|\bhh\b|\bch\b/.test(lower)) return 'kit/hat-closed';
  if (/\bkick|\bkik\b|\bbd\b|bass ?drum/.test(lower)) return 'kit/kick';
  if (/snare|\bsnr\b|\bsd\b/.test(lower)) return 'kit/snare';
  if (/clap/.test(lower)) return 'kit/clap';
  if (/crash|cymbal|\bride\b/.test(lower)) return 'kit/crash';
  if (/\brim/.test(lower)) return 'kit/rim';
  if (/cowbell/.test(lower)) return 'kit/cowbell';
  if (/low ?tom|tom ?low|floor ?tom/.test(lower)) return 'kit/tom-low';
  if (/hi(gh)? ?tom|tom ?hi/.test(lower)) return 'kit/tom-high';
  if (/\btom/.test(lower)) return 'kit/tom-mid';
  return undefined;
}

/** Names of drum kits and drum plugins. */
const DRUMS_PATTERN =
  /\bdrums?\b|\bkit\b|\bperc|\bfpc\b|battery|addictive drums|ezdrummer|superior drummer|steven slate|\bxo\b/;

/** FL native generators (internal names, lowercase) → built-in. */
const NATIVE_GENERATORS: Record<string, PluginChoice> = {
  '3x osc': { pluginId: FLP_PLUGIN.threeOsc, standIn: false },
  'fl keys': { pluginId: FLP_PLUGIN.threeOsc, params: KEYS_3XOSC, standIn: true },
  fpc: { pluginId: FLP_PLUGIN.drumPads, standIn: true },
  'fruity drumsynth live': { pluginId: FLP_PLUGIN.drumSynth, standIn: true },
  drumaxx: { pluginId: FLP_PLUGIN.drumSynth, standIn: true },
  'fruit kick': { pluginId: FLP_PLUGIN.sampler, kit: 'kit/kick', standIn: true },
  sytrus: { pluginId: FLP_PLUGIN.fm, standIn: true },
  'toxic biohazard': { pluginId: FLP_PLUGIN.fm, standIn: true },
  'fruity dx10': { pluginId: FLP_PLUGIN.fm, standIn: true },
  'plucked!': { pluginId: FLP_PLUGIN.pluck, standIn: true },
  sakura: { pluginId: FLP_PLUGIN.pluck, standIn: true },
  'fl slayer': { pluginId: FLP_PLUGIN.pluck, standIn: true },
  'fruity slicer': { pluginId: FLP_PLUGIN.slicer, standIn: true },
  slicex: { pluginId: FLP_PLUGIN.slicer, standIn: true },
  directwave: { pluginId: FLP_PLUGIN.sampler, standIn: true },
  'fruity granulizer': { pluginId: FLP_PLUGIN.sampler, standIn: true },
};

/** A VST/AU instrument's name → built-in. */
function vstInstrumentChoice(name: string): PluginChoice {
  const lower = name.toLowerCase();
  if (/808/.test(lower)) return { pluginId: FLP_PLUGIN.bass808, standIn: true };
  if (DRUMS_PATTERN.test(lower)) return { pluginId: FLP_PLUGIN.drumPads, standIn: true };
  if (/piano|keys|keyscape|pianoteq|ivory|grand|rhodes|wurli|organ/.test(lower)) {
    return { pluginId: FLP_PLUGIN.threeOsc, params: KEYS_3XOSC, standIn: true };
  }
  if (/fm8|dexed|\bfm\b|operator|opal/.test(lower)) return { pluginId: FLP_PLUGIN.fm, standIn: true };
  if (/pluck|guitar|harp|koto|kalimba/.test(lower)) return { pluginId: FLP_PLUGIN.pluck, standIn: true };
  return { pluginId: FLP_PLUGIN.wavetable, standIn: true };
}

const normalizedInternalName = (plugin: { internalName?: string }): string =>
  (plugin.internalName ?? '').trim().toLowerCase();

/** Is this channel FL's Sampler (or an audio clip channel, which looks the same)? */
export function isSamplerChannel(channel: FlpChannel): boolean {
  const name = normalizedInternalName(channel);
  return name === '' || name === 'sampler' || name === 'audio clip' || name === 'audioclip';
}

/** True for FL's wrapper around VST/AU plugins. */
export function isVst(plugin: { internalName?: string }): boolean {
  return normalizedInternalName(plugin) === 'fruity wrapper';
}

/** The FL plugin's name as people know it: the VST's own name, else the internal name. */
export function pluginLabel(plugin: { internalName?: string; vst?: FlpVst; name?: string }): string {
  if (isVst(plugin)) return plugin.vst?.name || plugin.name || 'VST plugin';
  return plugin.internalName || 'plugin';
}

/** Generator → built-in: names first (808s, single drums, drum kits), then the plugin. */
export function generatorChoice(channel: FlpChannel, name: string): PluginChoice {
  const lowerName = name.toLowerCase();
  const internal = normalizedInternalName(channel);
  const exact = NATIVE_GENERATORS[internal];
  if (exact && !exact.standIn) return exact;
  if (/808/.test(lowerName)) return { pluginId: FLP_PLUGIN.bass808, standIn: true };
  const kit = kitFromName(name);
  if (kit && internal !== 'fpc') return { pluginId: FLP_PLUGIN.sampler, kit, standIn: true };
  if (DRUMS_PATTERN.test(lowerName)) return { pluginId: FLP_PLUGIN.drumPads, standIn: true };
  if (exact) return exact;
  if (isVst(channel)) return vstInstrumentChoice(channel.vst?.name || channel.name || '');
  return { pluginId: FLP_PLUGIN.wavetable, standIn: true };
}

/** FL native effects (internal names, lowercase) → built-in effect id. */
const NATIVE_EFFECTS: Record<string, string> = {
  'fruity limiter': 'agstudio.limiter',
  'fruity compressor': 'agstudio.compressor',
  'fruity multiband compressor': 'agstudio.multiband',
  maximus: 'agstudio.multiband',
  soundgoodizer: 'agstudio.multiband',
  'fruity parametric eq 2': 'agstudio.eq-pro',
  'fruity parametric eq': 'agstudio.eq-pro',
  'fruity 7 band eq': 'agstudio.eq',
  'fruity reeverb 2': 'agstudio.reverb',
  'fruity reeverb': 'agstudio.reverb',
  'fruity reverb 2': 'agstudio.reverb',
  'fruity convolver': 'agstudio.reverb',
  'fruity delay 3': 'agstudio.delay',
  'fruity delay 2': 'agstudio.delay',
  'fruity delay': 'agstudio.delay',
  'fruity delay bank': 'agstudio.delay',
  'fruity chorus': 'agstudio.chorus',
  'fruity flanger': 'agstudio.flanger',
  'fruity flangus': 'agstudio.flanger',
  'fruity phaser': 'agstudio.phaser',
  'fruity filter': 'agstudio.filter',
  'fruity love philter': 'agstudio.filter',
  'fruity free filter': 'agstudio.filter',
  'fruity fast dist': 'agstudio.distortion',
  'fruity blood overdrive': 'agstudio.distortion',
  distructor: 'agstudio.distortion',
  'fruity waveshaper': 'agstudio.distortion',
  'fruity soft clipper': 'agstudio.saturator',
  'fruity squeeze': 'agstudio.lofi',
  'fruity stereo enhancer': 'agstudio.stereo',
  'fruity stereo shaper': 'agstudio.stereo',
  'transient processor': 'agstudio.transient',
  'fruity vocoder': 'agstudio.vocoder',
  vocodex: 'agstudio.vocoder',
  pitcher: 'agstudio.tune',
  newtone: 'agstudio.tune',
  'fruity spectroman': 'agstudio.analyzer',
  'wave candy': 'agstudio.analyzer',
  'gross beat': 'agstudio.stutter',
};

/** A VST effect's name → built-in, only where the kind is plain from the name. */
function vstEffect(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/verb|\broom\b|\bhall\b|plate/.test(lower)) return 'agstudio.reverb';
  if (/delay|echo/.test(lower)) return 'agstudio.delay';
  if (/limit/.test(lower)) return 'agstudio.limiter';
  if (/multiband|ott/.test(lower)) return 'agstudio.multiband';
  if (/comp|1176|la-2a|\bcla\b/.test(lower)) return 'agstudio.compressor';
  if (/\beq\b|pro-q|equal/.test(lower)) return 'agstudio.eq-pro';
  if (/chorus/.test(lower)) return 'agstudio.chorus';
  if (/phaser/.test(lower)) return 'agstudio.phaser';
  if (/flang/.test(lower)) return 'agstudio.flanger';
  if (/satur|tape|decapitator/.test(lower)) return 'agstudio.saturator';
  if (/distort|overdrive|fuzz/.test(lower)) return 'agstudio.distortion';
  if (/auto-?tune|melodyne|pitch correct/.test(lower)) return 'agstudio.tune';
  return undefined;
}

/** The built-in effect id for a mixer slot's FL effect, or undefined when it has no counterpart. */
export function effectFor(slot: FlpSlot): string | undefined {
  if (isVst(slot)) return vstEffect(slot.vst?.name || slot.name || '');
  return NATIVE_EFFECTS[normalizedInternalName(slot)];
}
