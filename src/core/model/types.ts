/**
 * Project document, schema v2. This is what gets saved (project.json) and what undo/redo operates on.
 * Every value is JSON-serializable. Entities live in Record<Id, T> maps plus order arrays so Immer
 * patches stay small and every entity keeps its reference identity until it changes.
 */
import type { ParamValue } from '@agstudio/sdk/params';
import type { Json } from './json';

export const SCHEMA_VERSION = 3;

/** Integer ticks at PPQ 960. */
export type Tick = number;

declare const brand: unique symbol;
type Id<B extends string> = string & { readonly [brand]: B };

export type ChannelId = Id<'ch'>;
export type PatternId = Id<'pat'>;
export type NoteId = Id<'n'>;
export type LaneId = Id<'lane'>;
export type ClipId = Id<'clip'>;
export type InsertId = Id<'ins'>;
export type SlotId = Id<'fx'>;
export type SampleId = Id<'smp'>;
export type LinkId = Id<'lnk'>;
export type MarkerId = Id<'mk'>;

/** The master insert has a fixed id. */
export const MASTER = 'master' as InsertId;

export interface Project {
  schemaVersion: number;
  /** Stable identity across saves (autosave/recovery). */
  projectId: string;
  meta: ProjectMeta;
  transport: TransportSettings;
  channels: Record<ChannelId, Channel>;
  channelOrder: ChannelId[];
  patterns: Record<PatternId, Pattern>;
  patternOrder: PatternId[];
  playlist: Playlist;
  mixer: Mixer;
  samples: Record<SampleId, SampleRef>;
  /** MIDI controller links ("Link to controller"), keyed by id. */
  controllers: Record<LinkId, ControllerLink>;
  /**
   * The DJ mix the auto-mix wrote into this project (absent otherwise): its songs in order, the
   * options and per-transition tweaks it was made with, and what it made (replaced when it is made
   * again). Added in v3 (optional).
   */
  dj?: DjMixState;
}

export interface DjMixState {
  songs: DjMixSong[];
  options: DjMixOptions;
  /** Tweaks of single transitions, by the incoming song's sample id. */
  tweaks: Record<string, DjTransitionTweak>;
  /** Channels (songs, curves, the tempo, risers) and markers the mix made. */
  made: { channels: ChannelId[]; markers: MarkerId[] };
}

export interface DjMixSong {
  sampleId: SampleId;
  /** "Artist – Title" or the file name. */
  title: string;
  /** Its own tempo (null: no steady beat) and key (Camelot, e.g. "8A"; null: unknown). */
  bpm: number | null;
  camelot: string | null;
  deck: 'A' | 'B';
  /** Where it plays in the mix. */
  start: Tick;
  end: Tick;
  /** Auto order keeps it at this position. */
  pinned?: boolean;
}

export interface DjMixOptions {
  order: 'keep' | 'auto';
  energy: 'build' | 'party' | 'chill' | 'peak-time';
  transition: 'auto' | 'smooth' | 'quick' | 'cut';
  /** 'follow' (each song at its own tempo) or one BPM for the whole mix. */
  mixTempo: 'follow' | number;
  lengthTargetMin?: number;
}

export interface DjTransitionTweak {
  bars?: number;
  recipe?: 'bass-swap' | 'filter' | 'echo' | 'cut';
  riser?: boolean;
}

export interface ProjectMeta {
  title: string;
  author?: string;
  createdAt: string;
  appVersion: string;
}

export interface TimeSignature {
  num: number;
  den: number;
}

export interface TransportSettings {
  bpm: number;
  timeSig: TimeSignature;
  /** Global swing 0–1: delays every second 1/16 step by up to half a step. */
  swing: number;
  /** The song's key (scale highlighting and snapping, the AI); absent = no key set. */
  key?: SongKey;
}

export interface SongKey {
  /** Pitch class of the tonic, 0 (C) – 11 (B). */
  root: number;
  /** Scale id from `@agstudio/sdk/notes` (e.g. 'major', 'minor'); unknown ids read as major. */
  scale: string;
}

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

interface ChannelBase {
  id: ChannelId;
  name: string;
  color: string;
  muted: boolean;
  solo: boolean;
}

interface Audible {
  /** Linear gain, 0–1.25 (FL-style channel volume; default 0.78). */
  volume: number;
  /** -1 (left) … 1 (right). */
  pan: number;
  /** Mixer insert this channel feeds. */
  output: InsertId;
}

export interface InstrumentChannel extends ChannelBase, Audible {
  kind: 'instrument';
  plugin: PluginInstance;
  /** Key used by step-sequencer notes and as the sampler's original pitch (60 = FL's C5). */
  rootKey: number;
  /** Channel pitch in cents (−2400…2400, FL's pitch knob); absent = 0. Reaches instruments as `host.channel.pitch`. */
  pitch?: number;
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
}

export type AudioStretch = 'off' | 'resample' | 'stretch';
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

export type Channel = InstrumentChannel | AudioClipChannel | AutomationChannel;

export interface Pattern {
  id: PatternId;
  name: string;
  color: string;
  /** Width of the channel-rack step grid (16 = one 4/4 bar). */
  stepCount: number;
  /** Explicit length; undefined = derived from content (whole bars, at least one). */
  length?: Tick;
  /** Notes per channel; a missing key means the channel has no notes in this pattern. */
  notes: Record<ChannelId, Record<NoteId, Note>>;
  /**
   * A variation the arranger made of another pattern ("Drop · fill + slide"): where it came from and
   * what was changed. It is rebuilt when its source changes, unless its notes were edited by hand
   * (they no longer match `hash`). Absent for ordinary patterns. Added in v3 (optional).
   */
  derived?: PatternDerivation;
}

/** Where a variant pattern came from (see `Pattern.derived`). */
export interface PatternDerivation {
  /** The pattern it varies (the editable source). */
  from: PatternId;
  /** The changes, applied to the source's notes in order. */
  steps: VariantStep[];
  /** Seed of the variation's choices (velocity jitter), so a rebuild sounds the same. */
  seed: number;
  /** Hash of the notes as the arranger wrote them (`notesHash`); different notes = edited by hand. */
  hash: string;
}

/** What a variant step does to its span (see `core/arrange/fills.ts`). */
export const VARIANT_KINDS = [
  'snare-fill',
  'tom-fill',
  'hat-fill',
  'kick-fill',
  'snare-build',
  'hat-roll',
  'open-hat',
  'slide',
  'gap',
  'dropout',
  'stutter',
  'thin',
  'double-hats',
  'without',
  'clear-drums',
] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

/** One change a variant makes to its source, over a span of the pattern. */
export interface VariantStep {
  kind: VariantKind;
  /** Pattern ticks, [from, to). */
  from: Tick;
  to: Tick;
  /**
   * For a change spread over several clips (a 4-bar snare build over 2-bar loops): where this part
   * starts inside the whole change, and the whole change's length.
   */
  offset?: Tick;
  total?: Tick;
  /** 1–5: the section's energy (velocities scale with it). */
  energy?: number;
  /** thin: 1 (lighter) or 2 (sparse). */
  level?: number;
  /** without: channel ids or parts (kick, snare, hats, perc, crash, drums, 808, bass, chords, lead, music, fx). */
  parts?: string[];
}

export interface Note {
  id: NoteId;
  /** Pattern-relative start. */
  tick: Tick;
  /** ≥ 1 tick. */
  length: Tick;
  key: number;
  /** 0–1. */
  velocity: number;
  pan?: number;
  muted?: boolean;
  /** Release velocity 0–1 (FL's "release"); absent = 0.5. */
  release?: number;
  /** Fine pitch in cents, −100…100; absent = 0. */
  fine?: number;
}

export interface Playlist {
  lanes: Record<LaneId, Lane>;
  laneOrder: LaneId[];
  clips: Record<ClipId, Clip>;
  /** Named song positions ("Verse", "Drop") shown on the playlist ruler. */
  markers: Record<MarkerId, Marker>;
}

export interface Marker {
  id: MarkerId;
  tick: Tick;
  name: string;
  color?: string;
}

export interface Lane {
  id: LaneId;
  name: string;
  color?: string;
  muted: boolean;
  solo?: boolean;
}

interface ClipBase {
  id: ClipId;
  laneId: LaneId;
  start: Tick;
  length: Tick;
  muted?: boolean;
  name?: string;
  color?: string;
}

export interface PatternClip extends ClipBase {
  kind: 'pattern';
  patternId: PatternId;
  /** Content offset: content tick = (clipLocal + offset) mod patternLength. */
  offset: Tick;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  channelId: ChannelId;
  /** Trim into the sample, in seconds (unaffected by tempo changes). */
  offsetSec: number;
  /** Clip gain, linear 0–4 (absent = 1). */
  gain?: number;
  /** Fade-in and fade-out lengths in seconds (absent = none). */
  fadeIn?: number;
  fadeOut?: number;
}

/** Plays an automation channel's curve over its span (content does not repeat). */
export interface AutomationClip extends ClipBase {
  kind: 'automation';
  channelId: ChannelId;
  /** Content offset: content tick = clipLocal + offset. */
  offset: Tick;
}

export type Clip = PatternClip | AudioClip | AutomationClip;

export type PluginOwner =
  { kind: 'channel'; channelId: ChannelId } | { kind: 'fx'; insertId: InsertId; slotId: SlotId };

/** Something automation, MIDI links and the AI can drive. */
export type ParamTarget =
  | { kind: 'channel'; channelId: ChannelId; param: 'volume' | 'pan' | 'pitch' }
  | { kind: 'insert'; insertId: InsertId; param: 'volume' | 'pan' }
  | { kind: 'slot'; insertId: InsertId; slotId: SlotId; param: 'mix' }
  | { kind: 'route'; insertId: InsertId; to: InsertId }
  | { kind: 'plugin'; owner: PluginOwner; paramId: string }
  | { kind: 'tempo' };

/** How the curve gets from a point to the next one. */
export type AutoShape = 'curve' | 'hold' | 'stairs' | 'smooth';
export const AUTO_SHAPES: readonly AutoShape[] = ['curve', 'hold', 'stairs', 'smooth'];

export interface AutoPoint {
  tick: Tick;
  /** Normalized 0–1. */
  value: number;
  /** Bend of the segment leaving this point, −1…1 (0 = straight). */
  tension?: number;
  /** Shape of the segment leaving this point; absent = 'curve'. */
  shape?: AutoShape;
}

/** "Link to controller": a MIDI control change that drives a target. */
export interface ControllerLink {
  id: LinkId;
  /** Controller number 0–127. */
  cc: number;
  /** MIDI channel 0–15, or null for any channel. */
  channel: number | null;
  /** Input device name to match; absent = any input. */
  device?: string;
  target: ParamTarget;
  /** Normalized range the controller sweeps (min may exceed max to invert it). */
  min: number;
  max: number;
}

export interface Mixer {
  inserts: Record<InsertId, Insert>;
  /** order[0] is always MASTER; an insert's number is its index. */
  order: InsertId[];
}

export interface Insert {
  id: InsertId;
  name: string;
  color?: string;
  /** Linear gain (1 = 0 dB). */
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Ordered effect slots, no gaps. */
  fx: FxSlot[];
  /**
   * Where this insert's output goes (at most one route per target). New inserts route to the
   * master; the master has none. No routes = silent. The routes and sidechains form no cycle.
   */
  routes: Route[];
}

export interface Route {
  to: InsertId;
  /** Linear send gain (1 = 0 dB). */
  level: number;
  /** Taken before the insert's pan and fader instead of after them. */
  pre: boolean;
}

export interface FxSlot {
  id: SlotId;
  plugin: PluginInstance;
  enabled: boolean;
  /** Dry/wet 0–1. */
  mix: number;
  /** Insert whose output feeds this effect's sidechain input (effects that declare one); null = none. */
  sidechain: InsertId | null;
}

export type SampleSource =
  | { kind: 'builtin'; generator: string; version: number }
  | { kind: 'embedded'; hash: string; ext: string; originalName?: string };

export interface SampleRef {
  id: SampleId;
  name: string;
  source: SampleSource;
  /** Facts recorded at import time (absent for generated samples). */
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
}
