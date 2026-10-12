/**
 * Project document, schema v1. This is what gets saved (project.json) and what undo/redo operates on.
 * Every value is JSON-serializable. Entities live in Record<Id, T> maps plus order arrays so Immer
 * patches stay small and every entity keeps its reference identity until it changes.
 */
import type { ParamValue } from '@agstudio/sdk/params';
import type { Json } from './json';

export const SCHEMA_VERSION = 1;

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
}

/** FL's "audio clip" channel: what playlist audio clips play through. */
export interface AudioClipChannel extends ChannelBase, Audible {
  kind: 'audioClip';
  sampleId: SampleId;
}

/** Reserved for automation clips (not creatable in v1). */
export interface AutomationChannel extends ChannelBase {
  kind: 'automation';
  target: ParamTarget | null;
  points: AutoPoint[];
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
}

export interface Playlist {
  lanes: Record<LaneId, Lane>;
  laneOrder: LaneId[];
  clips: Record<ClipId, Clip>;
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
}

/** Reserved for automation clips (not creatable in v1). */
export interface AutomationClip extends ClipBase {
  kind: 'automation';
  channelId: ChannelId;
  offset: Tick;
}

export type Clip = PatternClip | AudioClip | AutomationClip;

export type PluginOwner =
  { kind: 'channel'; channelId: ChannelId } | { kind: 'fx'; insertId: InsertId; slotId: SlotId };

export type ParamTarget =
  | { kind: 'channel'; channelId: ChannelId; param: 'volume' | 'pan' }
  | { kind: 'insert'; insertId: InsertId; param: 'volume' | 'pan' }
  | { kind: 'plugin'; owner: PluginOwner; paramId: string }
  | { kind: 'tempo' };

export interface AutoPoint {
  tick: Tick;
  /** Normalized 0–1. */
  value: number;
  tension?: number;
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
}

export interface FxSlot {
  id: SlotId;
  plugin: PluginInstance;
  enabled: boolean;
  /** Dry/wet 0–1. */
  mix: number;
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
