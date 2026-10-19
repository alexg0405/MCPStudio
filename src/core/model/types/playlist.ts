import type { HarmonyVoiceRecord } from './harmony';
import type { ChannelId, ClipId, LaneId, MarkerId, PatternId, SampleId, Tick } from './ids';

/** The song's arrangement: tracks (lanes) of clips, and the markers on the ruler. */
export interface Playlist {
  lanes: Record<LaneId, Lane>;
  laneOrder: LaneId[];
  clips: Record<ClipId, Clip>;
  /** Named song positions ("Verse", "Drop") shown on the playlist ruler. */
  markers: Record<MarkerId, Marker>;
}

/** A named song position on the playlist ruler. */
export interface Marker {
  id: MarkerId;
  tick: Tick;
  name: string;
  color?: string;
}

/** A track of the playlist. */
export interface Lane {
  id: LaneId;
  name: string;
  color?: string;
  muted: boolean;
  solo?: boolean;
  /** Set on the comp lane and the take lanes of a recording (takes and comping); absent for ordinary tracks. */
  takes?: LaneTakes;
}

/** What a track of a take group is: its comp lane, or one of the take lanes folded under it. */
export interface LaneTakes {
  group: string;
  role: 'comp' | 'take';
  /** Comp lane: the crossfade at the comp's borders, in milliseconds (absent = the default, 10). */
  crossfadeMs?: number;
}

/** What every clip has: where it sits and how long it is. */
interface ClipBase {
  id: ClipId;
  laneId: LaneId;
  start: Tick;
  length: Tick;
  muted?: boolean;
  name?: string;
  color?: string;
}

/** A clip that plays a pattern (looping its content over the clip). */
export interface PatternClip extends ClipBase {
  kind: 'pattern';
  patternId: PatternId;
  /** Content offset: content tick = (clipLocal + offset) mod patternLength. */
  offset: Tick;
}

/** A clip that plays audio through an audio clip channel. */
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
  /**
   * The Pitch editor's edits of this clip's sound: per-note pitch moves, drift and vibrato. A render
   * of them (TD-PSOLA, written through the sample store) is what the clip plays; the channel's own
   * sample stays as it was. Absent = untouched. (See core/audio/pitch-edit.ts.)
   */
  pitchEdit?: PitchEdit;
  /** Set when the clip is one take of a recording, or a piece of its comp (takes and comping). */
  take?: TakeTag;
  // ---- Harmony voices (optional; one block, added with "Make harmonies…") ----
  /** Set when this clip is a harmony voice made from a lead clip: how it was made, so it can be made again ("Update harmonies"). */
  harmony?: HarmonyVoiceRecord;
}

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

/** The Pitch editor's edits of one clip. */
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

/** Any clip of the playlist. */
export type Clip = PatternClip | AudioClip | AutomationClip;
