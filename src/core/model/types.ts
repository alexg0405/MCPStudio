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
export type LaunchTrackId = Id<'lt'>;
export type SceneId = Id<'sc'>;

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
  /**
   * The reference track (absent when none is set): a song the musician owns, measured. Only derived
   * numbers (tempo, key, sections and energy, loudness, tonal balance, stereo width) are kept in the
   * document; its audio is never part of the song. Added in v3 (optional).
   */
  reference?: ReferenceTrack;
  /**
   * The clip launcher's grid (Performance mode): tracks × scenes of slots that point at patterns and audio
   * channels. Absent until a slot is filled. Launching is session state (`core/launcher`), never in the
   * document. Added in v3 (optional).
   */
  launcher?: Launcher;
}

/** How a launcher slot reacts to its pad or button. */
export const LAUNCH_MODES = ['trigger', 'toggle', 'gate', 'retrigger'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/** When a launch or stop happens: at once, or at the next beat, bar, 2 bars or 4 bars. */
export const LAUNCH_QUANTIZES = ['none', 'beat', 'bar', '2bars', '4bars'] as const;
export type LaunchQuantize = (typeof LAUNCH_QUANTIZES)[number];

/** What a slot does after it has played for `bars` bars. */
export const FOLLOW_KINDS = ['next', 'random', 'stop'] as const;
export type FollowKind = (typeof FOLLOW_KINDS)[number];
export interface FollowAction {
  kind: FollowKind;
  /** 1–64 bars after the slot started. */
  bars: number;
}

/** What a slot plays: a pattern, or an audio clip channel's sample (never a copy of the audio). */
export type LaunchContent =
  | { kind: 'pattern'; patternId: PatternId }
  | {
      kind: 'audio';
      channelId: ChannelId;
      /** Trim into the sample, in seconds. */
      offsetSec: number;
      /** One pass of the clip, in ticks (a loop repeats it). */
      length: Tick;
      gain?: number;
      fadeIn?: number;
      fadeOut?: number;
    };

export interface LaunchSlot {
  content: LaunchContent;
  /** Shown in the slot (default: the pattern's or channel's name). */
  name?: string;
  color?: string;
  /** Absent = 'trigger'. */
  mode?: LaunchMode;
  /** Absent = true (loops until stopped); false plays once. */
  loop?: boolean;
  /** Absent = the grid's own. */
  quantize?: LaunchQuantize;
  follow?: FollowAction;
}

/** A column of the grid; it plays one slot at a time. */
export interface LaunchTrack {
  id: LaunchTrackId;
  name: string;
  color?: string;
  /** The playlist track it takes over while one of its slots plays (FL's Performance mode); absent = none. */
  laneId?: LaneId;
  slots: Record<SceneId, LaunchSlot>;
}

/** A row of the grid: launching it launches its slot in every track. */
export interface LaunchScene {
  id: SceneId;
  name: string;
  color?: string;
}

export interface Launcher {
  /** The default quantize of launches and stops. */
  quantize: LaunchQuantize;
  tracks: Record<LaunchTrackId, LaunchTrack>;
  trackOrder: LaunchTrackId[];
  scenes: Record<SceneId, LaunchScene>;
  sceneOrder: SceneId[];
}

/** The measurements of a reference song (see `core/reference`). */
export interface ReferenceTrack {
  /**
   * The file as a sample of the project (for the title and for analyzing it again). It is kept out of the
   * song: no channel or clip plays it. Absent when the sample is gone.
   */
  sampleId?: SampleId;
  /** "Artist – Title" or the file name. */
  title: string;
  /** Content hash of the file. */
  hash: string;
  durationSec: number;
  /** Tempo in BPM (null: no steady beat found) and beats per bar. */
  bpm: number | null;
  beatsPerBar: number;
  /** Key (null: none found) with Camelot code and how sure the analysis is, 0–1. */
  key: { root: number; mode: 'major' | 'minor'; camelot: string; confidence: number } | null;
  /** Integrated loudness (LUFS) and true peak (dBTP) of the whole song. */
  lufs: number;
  truePeakDb: number;
  /** Tonal balance of the whole song: each band's share of the energy in dB under the total (`core/reference/bands.ts`). */
  bands: number[];
  /** Stereo width: side energy over mid energy (0 = mono). */
  width: number;
  /** Energy 0–1 per bar of the reference's own grid (per 2 s without a grid), at most 1024 values. */
  energy: number[];
  sections: ReferenceSection[];
  /** The analysis code's version when measured (older ones are measured again when the song is looked at). */
  version: number;
}

export interface ReferenceSection {
  kind: 'intro' | 'build' | 'drop' | 'break' | 'verse' | 'outro' | 'body';
  /** Seconds in the reference's file. */
  startSec: number;
  endSec: number;
  /** Length in bars of the reference's own grid (a bar of its tempo; 2 s without a grid). */
  bars: number;
  /** 0–1 relative energy within the song. */
  energy: number;
  /** Tonal balance (as `ReferenceTrack.bands`) and stereo width of this section. */
  bands: number[];
  width: number;
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
  /** Songs keep their pitch when the tempo moves them (time-stretch) instead of bending it like a turntable. */
  keyLock?: boolean;
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
  // ---- Pitch correction (optional, added with the Pitch editor; see core/audio/pitch-edit.ts) ----
  /**
   * The Pitch editor's edits of this clip's sound: per-note pitch moves, drift and vibrato. A render
   * of them (TD-PSOLA, written through the sample store) is what the clip plays; the channel's own
   * sample stays as it was. Absent = untouched.
   */
  pitchEdit?: PitchEdit;
  // ---- end of pitch correction ----
}

/** One note of a clip's sung line, as the Pitch editor edits it (seconds on the sample's own timeline). */
export interface PitchEditNote {
  from: number;
  to: number;
  /** The pitch it was sung at: a MIDI note (60 = C4; fractions are cents). */
  pitch: number;
  /** Cents the whole note is moved by (the target is `pitch` + shift ÷ 100). Absent = 0. */
  shift?: number;
  /** How much of the note's slow pitch drift is flattened, 0–1 (absent = 0: as sung). */
  drift?: number;
  /** Vibrato amount: 0 removes it, 1 keeps it as sung (absent), up to 2 doubles it. */
  vibrato?: number;
}

export interface PitchEdit {
  /** The notes, in time order and not overlapping. */
  notes: PitchEditNote[];
  /** Milliseconds a pitch move takes to glide in at note borders (absent = 25). */
  transition?: number;
  /** The sample (in `Project.samples`) holding the render of these edits; absent while it is not made yet. */
  renderedSampleId?: SampleId;
  /** The `editSignature` of the edits `renderedSampleId` was made from (it is out of date when they differ). */
  renderedFor?: string;
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

// ---- Takes and comping (B1): optional fields, merged into the interfaces above ----

/**
 * Ties the takes of one recording together. A take clip has `{ group, index }` (0 = the first pass, in the
 * recording's order); a clip of the comp lane (plain audio clips split at the comp's borders) also has
 * `comp: true` and the index of the take it plays.
 */
export interface TakeTag {
  group: string;
  index: number;
  comp?: true;
}

/** What a track of a take group is: its comp lane, or one of the take lanes folded under it. */
export interface LaneTakes {
  group: string;
  role: 'comp' | 'take';
  /** Comp lane: the crossfade at the comp's borders, in milliseconds (absent = the default, 10). */
  crossfadeMs?: number;
}

export interface AudioClip {
  take?: TakeTag;
}

export interface Lane {
  takes?: LaneTakes;
}
