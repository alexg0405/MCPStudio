/**
 * Scheduling helpers of the audio clip player: the gain of a clip voice (its fades, with a short ramp from silence
 * when it starts inside the sound), its release, and the start that keeps a plain-speed clip sample for sample.
 */
import { clipEnvelopeAt, envelopeBreakpoints } from '@core/audio/envelope';
import type { AudioClip } from '@core/model/types';

/** Ramp from silence when a clip starts inside its sound on a non-zero envelope (no fade-in), in seconds. */
const ANTI_CLICK_SEC = 0.002;
/** Fade when a clip is cut short (stop, loop wrap, seek) or ends without a fade-out, in seconds. */
export const RELEASE_SEC = 0.004;
/** How far an envelope position may be from the clip's start and still count as "at the very beginning" (seconds). */
const AT_START_EPSILON_SEC = 1e-9;
/** A playback rate this close to 1 is treated as exactly 1 (a stretched copy is 1 within the scale's rounding: under 2 ms over six minutes). */
const UNITY_RATE_TOLERANCE = 1e-5;
/** Slack when rounding a start time up to a whole frame (frames): a start never lands before `now`. */
const FRAME_ROUNDING_SLACK = 1e-6;

/** A gain schedule as written: [time, value] points joined by linear ramps (held after the last one). */
export type GainSchedule = Array<[time: number, value: number]>;

/** The scheduled gain at `time`: linear between points, held before the first and after the last. */
export function gainAt(schedule: GainSchedule, time: number): number {
  let previous = schedule[0];
  if (!previous || time <= previous[0]) return previous?.[1] ?? 0;
  for (let i = 1; i < schedule.length; i++) {
    const point = schedule[i] as [number, number];
    if (time <= point[0]) {
      const span = point[0] - previous[0] || 1;
      return previous[1] + ((point[1] - previous[1]) * (time - previous[0])) / span;
    }
    previous = point;
  }
  return previous[1];
}

/**
 * Fades a gain out over RELEASE_SEC from `releaseTime`. cancelAndHoldAtTime alone isn't enough: when nothing is
 * scheduled after `releaseTime` (the last ramp ended long ago) Chrome inserts no hold point, and the release
 * ramp would then run from that old ramp's end, fading the whole clip. So the held value is set too.
 */
export function releaseGain(gain: AudioParam, schedule: GainSchedule, releaseTime: number): void {
  gain.cancelAndHoldAtTime(releaseTime);
  gain.setValueAtTime(gainAt(schedule, releaseTime), releaseTime);
  gain.linearRampToValueAtTime(0, releaseTime + RELEASE_SEC);
}

/**
 * Writes a clip voice's gain onto `gain`, from where the voice starts: the clip's envelope (gain and fades) from
 * `startInClipSec` seconds into the clip. Starting inside the sound on a non-zero envelope would click, so the gain
 * ramps in from silence; at the very beginning of the sound it starts there anyway (and a frozen or consolidated
 * render must keep its attack), so it starts at the envelope's value. Returns the schedule (for the release).
 */
export function scheduleClipGain(
  gain: AudioParam,
  clip: AudioClip,
  clipSeconds: number,
  startInClipSec: number,
  startInSampleSec: number,
  time: number,
): GainSchedule {
  const points = envelopeBreakpoints(clip, clipSeconds, startInClipSec);
  const startValue = points[0]?.[1] ?? 0;
  const startsInsideSound = startInClipSec > AT_START_EPSILON_SEC || startInSampleSec > AT_START_EPSILON_SEC;
  const rampFromSilence = startValue > 0 && startsInsideSound;
  const schedule: GainSchedule = [[time, rampFromSilence ? 0 : startValue]];
  gain.setValueAtTime(schedule[0]![1], time);
  let lastPosition = startInClipSec;
  if (rampFromSilence) {
    lastPosition = Math.min(clipSeconds, startInClipSec + ANTI_CLICK_SEC);
    schedule.push([time + (lastPosition - startInClipSec), clipEnvelopeAt(clip, lastPosition, clipSeconds)]);
  }
  for (const [position, value] of points) {
    if (position > lastPosition) schedule.push([time + (position - startInClipSec), value]);
  }
  for (let i = 1; i < schedule.length; i++) gain.linearRampToValueAtTime(schedule[i]![1], schedule[i]![0]);
  return schedule;
}

/** The ramp-in a preview plays with: silence to full over ANTI_CLICK_SEC. */
export function previewGainSchedule(time: number): GainSchedule {
  return [
    [time, 0],
    [time + ANTI_CLICK_SEC, 1],
  ];
}

/** Where a voice's buffer starts: the context time, and the position in the buffer (seconds), at the rate it plays. */
export interface BufferStart {
  rate: number;
  startAt: number;
  startOffset: number;
}

/**
 * At speed 1 the buffer is started on a whole frame at a whole frame (at most half a frame, 10 µs, off), so it is
 * copied sample for sample: a fractional start makes the browser interpolate the whole clip, which dulls the highs
 * (up to −6 dB at 16 kHz). Otherwise the start is exactly as asked.
 */
export function snapToWholeFrame(
  rate: number,
  time: number,
  offset: number,
  now: number,
  steady: boolean,
  bufferSampleRate: number,
  contextSampleRate: number,
): BufferStart {
  const isPlainSpeed = steady && Math.abs(rate - 1) < UNITY_RATE_TOLERANCE && bufferSampleRate === contextSampleRate;
  if (!isPlainSpeed) return { rate, startAt: time, startOffset: offset };
  const sampleRate = contextSampleRate;
  const frame = Math.max(Math.ceil(now * sampleRate - FRAME_ROUNDING_SLACK), Math.round(time * sampleRate));
  const startAt = frame / sampleRate;
  const startOffset = Math.max(0, Math.round((offset + (startAt - time)) * sampleRate) / sampleRate);
  return { rate: 1, startAt, startOffset };
}
