/**
 * How an audio clip plays its sample: which part of the sound is heard at each song position, and
 * how fast it runs. Shared by the engine (scheduling), the playlist (waveforms, trims, splits) and
 * the edit tools (normalize, slicing), so they always agree.
 *
 * The channel's `pitch` (cents) gives a factor P = 2^(cents/1200). With B = `sourceBpm`:
 *
 * | follow    | source seconds advance per song second | pitch heard        |
 * |-----------|----------------------------------------|--------------------|
 * | off       | P                                      | P (a resample)     |
 * | resample  | P · bpm(t) / B                         | P · bpm(t) / B     |
 * | stretch   | bpm(t) / B                             | P (time-stretched) |
 *
 * So 'resample' and 'stretch' lock the sound to beats (one source beat per song beat, with P = 1),
 * following tempo automation, while 'off' keeps the sound's own speed whatever the tempo does.
 * Reverse plays a reversed copy of the sample; `offsetSec` (the trim) is a position in that copy.
 */
import type { AudioClip, AudioClipChannel, SampleId, Tick } from '../model/types';
import { PPQ, type TempoMap } from '../time/ppq';

/**
 * How an audio clip channel follows the song tempo: not at all, by resampling (pitch follows the tempo) or by
 * time-stretching (pitch stays).
 */
export type FollowMode = 'off' | 'resample' | 'stretch';

/**
 * How an audio clip channel plays: its tempo-follow mode, its pitch shift (in cents and as a factor), the source tempo
 * it follows and whether it plays backwards.
 */
export interface PlaybackMode {
  /** What actually happens: a channel asking to follow the tempo without a source BPM plays 'off'. */
  follow: FollowMode;
  /** Pitch shift in cents. */
  cents: number;
  /** 2^(cents/1200). */
  pitch: number;
  /** The tempo the audio was recorded at (null when it doesn't follow the tempo). */
  sourceBpm: number | null;
  reverse: boolean;
}

type ModeFields = Pick<AudioClipChannel, 'pitch' | 'reverse' | 'stretch' | 'sourceBpm'>;

/** The playback mode of an audio clip channel. */
export function playbackMode(ch: ModeFields): PlaybackMode {
  const cents = Number.isFinite(ch.pitch) ? (ch.pitch as number) : 0;
  const bpm = ch.sourceBpm !== undefined && Number.isFinite(ch.sourceBpm) && ch.sourceBpm > 0 ? ch.sourceBpm : null;
  const follow: FollowMode = bpm !== null && (ch.stretch === 'resample' || ch.stretch === 'stretch') ? ch.stretch : 'off';
  return { follow, cents, pitch: Math.pow(2, cents / 1200), sourceBpm: follow === 'off' ? null : bpm, reverse: !!ch.reverse };
}

/** True when nothing changes how the sample plays (no pitch, reverse or tempo follow). */
export function isPlainPlayback(m: PlaybackMode): boolean {
  return m.follow === 'off' && m.cents === 0 && !m.reverse;
}

/**
 * Everything that decides what a channel's clips sound like. Playing clips restart when it changes
 * (volume, pan and names don't count).
 */
export function playbackKey(ch: ModeFields & Pick<AudioClipChannel, 'sampleId'>): string {
  const m = playbackMode(ch);
  return `${ch.sampleId}|${m.cents}|${m.reverse ? 1 : 0}|${m.follow}|${m.sourceBpm ?? ''}`;
}

/**
 * The sample a clip plays: the render of its pitch correction (`pitchEdit.renderedSampleId`, see
 * pitch-edit.ts) when it has one, else the channel's own. Both share one timeline (the render is
 * as long as the original), so trims, fades and tempo follow work on either.
 */
export function clipSampleId(channel: Pick<AudioClipChannel, 'sampleId'>, clip: Pick<AudioClip, 'pitchEdit'> | undefined): SampleId {
  return clip?.pitchEdit?.renderedSampleId ?? channel.sampleId;
}

/** Source seconds per tick in the tempo-locked modes. */
const secPerTickAt = (bpm: number) => 60 / (PPQ * bpm);

type ClipPos = Pick<AudioClip, 'start' | 'offsetSec'>;

/**
 * Seconds into the (reversed, when reverse is on) sample that the clip plays at song tick `tick`.
 * Not clamped: before the clip it is below `offsetSec`, past the sound's end above its duration.
 */
export function sourceSecondsAt(clip: ClipPos, mode: PlaybackMode, tempo: TempoMap, tick: number): number {
  switch (mode.follow) {
    case 'off':
      return clip.offsetSec + mode.pitch * (tempo.tickToSeconds(tick) - tempo.tickToSeconds(clip.start));
    case 'resample':
      return clip.offsetSec + mode.pitch * (tick - clip.start) * secPerTickAt(mode.sourceBpm as number);
    case 'stretch':
      return clip.offsetSec + (tick - clip.start) * secPerTickAt(mode.sourceBpm as number);
  }
}

/** The song tick at which the clip reaches `sec` seconds into its sample (the inverse of sourceSecondsAt). */
export function tickAtSourceSeconds(clip: ClipPos, mode: PlaybackMode, tempo: TempoMap, sec: number): number {
  const d = sec - clip.offsetSec;
  switch (mode.follow) {
    case 'off':
      return tempo.secondsToTick(tempo.tickToSeconds(clip.start) + d / mode.pitch);
    case 'resample':
      return clip.start + d / (mode.pitch * secPerTickAt(mode.sourceBpm as number));
    case 'stretch':
      return clip.start + d / secPerTickAt(mode.sourceBpm as number);
  }
}

/** Source seconds per song second at a tick: the sample's playback speed. */
export function sourceRateAt(mode: PlaybackMode, tempo: TempoMap, tick: number): number {
  switch (mode.follow) {
    case 'off':
      return mode.pitch;
    case 'resample':
      return (mode.pitch * tempo.bpmAt(tick)) / (mode.sourceBpm as number);
    case 'stretch':
      return tempo.bpmAt(tick) / (mode.sourceBpm as number);
  }
}

/** True when the playback speed follows the song tempo (tempo edits restart the clip). */
export function followsTempo(mode: PlaybackMode): boolean {
  return mode.follow !== 'off';
}

/** Clip length (ticks) that plays the sample from the clip's trim to its end, at least one tick. */
export function naturalLength(
  clip: ClipPos,
  mode: PlaybackMode,
  tempo: TempoMap,
  durationSec: number,
): Tick {
  const end = tickAtSourceSeconds(clip, mode, tempo, durationSec);
  return Math.max(1, Math.round(end - clip.start));
}

/** The source span [from, to) in seconds a clip plays (clamped to the sound). */
export function clipSourceRange(
  clip: ClipPos & Pick<AudioClip, 'length'>,
  mode: PlaybackMode,
  tempo: TempoMap,
  durationSec: number,
): { from: number; to: number } {
  const a = Math.max(0, Math.min(durationSec, clip.offsetSec));
  const b = Math.max(a, Math.min(durationSec, sourceSecondsAt(clip, mode, tempo, clip.start + clip.length)));
  return { from: a, to: b };
}

/**
 * The trim that keeps a clip on the same audio after reverse is switched (the sound's other end):
 * the span the clip covers is mirrored inside the sample.
 */
export function mirroredOffset(
  clip: ClipPos & Pick<AudioClip, 'length'>,
  mode: PlaybackMode,
  tempo: TempoMap,
  durationSec: number,
): number {
  const span = sourceSecondsAt(clip, mode, tempo, clip.start + clip.length) - clip.offsetSec;
  return Math.max(0, durationSec - clip.offsetSec - span);
}

/**
 * The scale a time-stretched copy of the sample needs for a clip in 'stretch' mode: the copy is
 * `scale` times as long as the sample and plays at speed `scale · bpm(t) / B` (pitch P at the
 * tempo where the clip starts). Rounded so clips at the same tempo share one copy.
 */
export function stretchScale(mode: PlaybackMode, tempo: TempoMap, startTick: number): number {
  if (mode.follow !== 'stretch' || !mode.sourceBpm) return 1;
  const r0 = tempo.bpmAt(startTick) / mode.sourceBpm;
  return Math.round((mode.pitch / r0) * 1e5) / 1e5;
}
