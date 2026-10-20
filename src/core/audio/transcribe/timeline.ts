/**
 * Where heard sounds land in the song: the clip's own mapping from seconds in its sample to song ticks (trim, pitch,
 * tempo follow and tempo automation all included, through the same maths playback uses). Pure.
 */
import type { AudioClip } from '../../model/types';
import type { TempoMap } from '../../time/ppq';
import { sourceRateAt, tickAtSourceSeconds, type PlaybackMode } from '../playback';

/** What the planner needs to know about the clip and the song. */
export interface ClipTimeline {
  /** The clip: where it sits in the song and which part of its sound it plays. */
  clip: Pick<AudioClip, 'start' | 'length' | 'offsetSec'>;
  mode: PlaybackMode;
  tempo: TempoMap;
  /** Ticks per beat and per bar of the song's time signature. */
  beatTicks: number;
  barTicks: number;
  /** The song's swing (0..1): written notes play with it. */
  songSwing: number;
}

/** The song tick at which the clip plays `sec` seconds of its sample (not clamped to the clip). */
export function songTickAt(timeline: ClipTimeline, sec: number): number {
  return tickAtSourceSeconds(timeline.clip, timeline.mode, timeline.tempo, sec);
}

/** The end of the clip in song ticks. */
export function clipEndTick(timeline: ClipTimeline): number {
  return timeline.clip.start + timeline.clip.length;
}

/**
 * Semitones the channel's playing moves the sound at a tick: its pitch setting, and the speed when it follows the tempo by
 * resampling (a stretched clip keeps its pitch apart from the setting). The notes written are the notes the song hears.
 */
export function heardShiftSemitones(timeline: ClipTimeline, tick: number): number {
  const rate = timeline.mode.follow === 'stretch' ? timeline.mode.pitch : sourceRateAt(timeline.mode, timeline.tempo, tick);
  return 12 * Math.log2(rate);
}
