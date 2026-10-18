/**
 * Frame timing for video export: which frames a stretch of audio makes, when each is shown, and
 * which sound each one looks at. Frames are numbered from 0; frame `i` is shown at `i / fps`.
 * Timestamps are whole microseconds (what WebCodecs counts in), rounded from the exact time, so the
 * error never builds up: the frame at one hour is as exact as the first.
 */

/** Frames to show for `seconds` of audio: enough to cover all of it, at least one. */
export function frameCountFor(seconds: number, fps: number): number {
  if (!(seconds > 0)) return 1;
  // Subtract a hair so 10.000000000001 s at 30 fps is 300 frames, not 301.
  return Math.max(1, Math.ceil(seconds * fps - 1e-6));
}

/** When frame `i` is shown, in microseconds from the start. */
export function frameTimeUs(i: number, fps: number): number {
  return Math.round((i * 1_000_000) / fps);
}

/** How long frame `i` stays (microseconds): the gap to the next, so the durations add up exactly. */
export function frameDurationUs(i: number, fps: number): number {
  return frameTimeUs(i + 1, fps) - frameTimeUs(i, fps);
}

/** The frame showing at `seconds` (the last one that has started). */
export function frameAtTime(seconds: number, fps: number): number {
  return Math.max(0, Math.floor(seconds * fps + 1e-9));
}

/** Frames between key frames: about `seconds`, at least 1. */
export function keyframeEvery(fps: number, seconds: number): number {
  return Math.max(1, Math.round(fps * seconds));
}

/** True when frame `i` must be a key frame. */
export function isKeyframe(i: number, fps: number, seconds: number): boolean {
  return i % keyframeEvery(fps, seconds) === 0;
}

/**
 * Audio sample frame (not video frame) a picture looks at: frame `i` shows the sound around its own
 * time `i / fps`, so a hit at that moment is in the picture the player shows with it.
 */
export function audioCenterFor(i: number, fps: number, sampleRate: number): number {
  return Math.round((i * sampleRate) / fps);
}

/** Microseconds of an audio position (sample frames), rounded the same way as frame times. */
export function audioTimeUs(frames: number, sampleRate: number): number {
  return Math.round((frames * 1_000_000) / sampleRate);
}

/** Whole video frames that can be drawn once `audioFrames` of sound have arrived, if each needs `lookAhead` sample frames after its center. */
export function framesReady(audioFrames: number, fps: number, sampleRate: number, lookAhead: number): number {
  // Frame i is ready when center(i) + lookAhead <= audioFrames, i.e. i <= (audioFrames - lookAhead) * fps / sampleRate.
  if (audioFrames < lookAhead) return 0;
  return Math.floor(((audioFrames - lookAhead) * fps) / sampleRate + 1e-9) + 1;
}

/** "3:07", "1:02:09": a time as a player shows it. */
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds + 1e-9));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
