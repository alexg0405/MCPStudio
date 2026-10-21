import type { ParamValue } from '@agstudio/sdk/params';
import type { Json } from '../json';
import type { AutoPoint, ParamTarget } from './automation';
import type { ChannelId, ClipId, InsertId, MidiFxSlotId, SampleId, SlotId, Tick } from './ids';
import type { Clip } from './playlist';

/** A plugin's saved data. The host owns it; plugins receive it and request changes. */
export interface PluginInstance {
  pluginId: string;
  /** The plugin definition's `version` when this was saved (drives the plugin's migrate()). */
  pluginVersion: number;
  /** Values keyed by param id: numbers in the declared unit, booleans, or enum option ids. */
  params: Record<string, ParamValue>;
  /** Small opaque JSON state for anything that is not a param. */
  state?: Json;
  /** Host-managed sample slots ('main', 'pad3', …). */
  samples?: Record<string, SampleId>;
}

/**
 * One MIDI effect in an instrument channel's chain (`InstrumentChannel.midiFx`): it changes the notes on their way to the
 * instrument, in the song and from live keys (`core/midi-fx`). Its settings are plain values like a plugin's.
 */
export interface MidiFxSlot {
  id: MidiFxSlotId;
  /** The effect's id in `core/midi-fx/registry` ('arp', 'chord', 'scale', 'repeat', 'humanize', 'velocity', 'transpose', 'echo', 'length', 'random'). Unknown ids are kept and skipped. */
  effect: string;
  /** False = bypassed: the notes pass through this effect unchanged. */
  enabled: boolean;
  /** Values keyed by the effect's param ids (numbers in the declared unit, booleans, option ids); missing ones are the defaults. */
  params: Record<string, ParamValue>;
}

/** What every channel has: an id, a name, a colour and the mute and solo switches. */
interface ChannelBase {
  id: ChannelId;
  name: string;
  color: string;
  muted: boolean;
  solo: boolean;
}

/** What a channel that makes sound has: its volume, pan and the mixer insert it feeds. */
interface Audible {
  /** Linear gain, 0–1.25 (FL-style channel volume; default 0.78). */
  volume: number;
  /** -1 (left) … 1 (right). */
  pan: number;
  /** Mixer insert this channel feeds. */
  output: InsertId;
}

/** A channel that plays a plugin instrument. */
export interface InstrumentChannel extends ChannelBase, Audible {
  kind: 'instrument';
  plugin: PluginInstance;
  /** Key used by step-sequencer notes and as the sampler's original pitch (60 = FL's C5). */
  rootKey: number;
  /** Channel pitch in cents (−2400…2400, FL's pitch knob); absent = 0. Reaches instruments as `host.channel.pitch`. */
  pitch?: number;
  /**
   * The MIDI effects the channel's notes go through before they reach the instrument, first to last (absent = none). They
   * run in the song and for live keys, never touch the notes stored in patterns, and `core/ops/midi-fx` can bake them
   * into the notes. Added in v3 (optional).
   */
  midiFx?: MidiFxSlot[];
}

/** FL's "audio clip" channel: what playlist audio clips play through. */
export interface AudioClipChannel extends ChannelBase, Audible {
  kind: 'audioClip';
  sampleId: SampleId;
  /** Pitch shift in cents (−2400…2400; absent = 0). With stretch 'off' it also changes the speed. */
  pitch?: number;
  /** Plays the sample backwards. */
  reverse?: boolean;
  /**
   * How the audio follows the song tempo: 'off' plays it at its own speed (absent = off),
   * 'resample' speeds it up or down with the tempo (pitch follows, like a turntable), 'stretch'
   * keeps its pitch (time-stretch). Both need `sourceBpm`.
   */
  stretch?: AudioStretch;
  /** The tempo the audio was recorded at (20–999 BPM), for stretch. */
  sourceBpm?: number;
  /**
   * "Freeze channel": this channel's audio is a render of that channel, which is muted meanwhile
   * (Unfreeze deletes this one and unmutes it). Absent for ordinary audio. Added in M15 (optional).
   */
  frozenFrom?: ChannelId;
  /**
   * "Sound filters": this channel's audio is a part of the song rendered and played through a
   * filter (Nightcore, Telephone…); what it replaced is kept here so "Remove filter" puts it back.
   * Absent for ordinary audio. Added in v3 (optional).
   */
  filter?: SoundFilter;
}

/** A sound filter applied to a part of the song (see `AudioClipChannel.filter`, core/filters). */
export interface SoundFilter {
  /** The preset's id ('nightcore', 'telephone'…; see core/filters/presets.ts). */
  preset: string;
  /** The part it replaced, [from, to). */
  from: Tick;
  to: Tick;
  /** The clips as they were before (whole, before being cut at the part's edges): put back on remove. */
  originals: Clip[];
  /** Pieces left outside the part when clips were cut at its edges: deleted on remove. */
  pieces: ClipId[];
  /**
   * The mixer track its effects are on: made for it (deleted on remove), or an empty one it borrowed
   * (renamed back to `name`, its `slots` removed).
   */
  insert?: { id: InsertId; made: boolean; name: string; slots: SlotId[] };
  /**
   * Speed filters change the tempo of the part: the song's tempo before (whole song) or the tempo
   * automation channel added over the part.
   */
  tempo?: { bpm: number } | { channelId: ChannelId };
}

/** How an audio clip channel follows the song tempo (see `AudioClipChannel.stretch`). */
export type AudioStretch = 'off' | 'resample' | 'stretch';
/** Every `AudioStretch`, for lists and for checking loose input. */
export const AUDIO_STRETCH: readonly AudioStretch[] = ['off', 'resample', 'stretch'];

/** An automation clip's curve (FL keeps it as a channel); its playlist clips play it. */
export interface AutomationChannel extends ChannelBase {
  kind: 'automation';
  /** What it drives; null (or a target whose owner was deleted) drives nothing. */
  target: ParamTarget | null;
  /** Sorted by tick (ticks from the start of the clip's content). */
  points: AutoPoint[];
  /**
   * Plain-unit range the normalized point values span (tempo: BPM, default 60–180); absent = the
   * target's own range.
   */
  range?: { min: number; max: number };
}

/** Any channel of the channel rack. */
export type Channel = InstrumentChannel | AudioClipChannel | AutomationChannel;
