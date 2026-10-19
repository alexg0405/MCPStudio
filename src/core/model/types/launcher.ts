import type { ChannelId, LaneId, LaunchTrackId, PatternId, SceneId, Tick } from './ids';

/** How a launcher slot reacts to its pad or button. */
export const LAUNCH_MODES = ['trigger', 'toggle', 'gate', 'retrigger'] as const;
/** One of `LAUNCH_MODES`: how a press on the slot's pad behaves. */
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/** When a launch or stop happens: at once, or at the next beat, bar, 2 bars or 4 bars. */
export const LAUNCH_QUANTIZES = ['none', 'beat', 'bar', '2bars', '4bars'] as const;
/** One of `LAUNCH_QUANTIZES`: the boundary a launch or stop waits for. */
export type LaunchQuantize = (typeof LAUNCH_QUANTIZES)[number];

/** What a slot does after it has played for `bars` bars. */
export const FOLLOW_KINDS = ['next', 'random', 'stop'] as const;
/** One of `FOLLOW_KINDS`: which slot a follow action hands over to. */
export type FollowKind = (typeof FOLLOW_KINDS)[number];

/** A slot's follow action: what happens, and after how many bars. */
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

/** One pad of the grid: what it plays and how it behaves. */
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

/** The clip launcher's grid: tracks (columns) by scenes (rows) of slots. */
export interface Launcher {
  /** The default quantize of launches and stops. */
  quantize: LaunchQuantize;
  tracks: Record<LaunchTrackId, LaunchTrack>;
  trackOrder: LaunchTrackId[];
  scenes: Record<SceneId, LaunchScene>;
  sceneOrder: SceneId[];
}
