/** Cutting the audio an alignment job needs out of decoded samples: the clip's stretch, and the guide on the same axis. */
import type { AudibleSpan } from '@core/audio/align';

/** The frames [startFrame, endFrame) of every channel (copies, so a Worker may take them). */
export interface Cut {
  startFrame: number;
  endFrame: number;
  channels: Float32Array[];
}

/** The part of a sample that covers `fromSec`..`toSec` (clipped to the sample), as copies of every channel. */
export function cutRegion(channels: readonly Float32Array[], sampleRate: number, fromSec: number, toSec: number): Cut {
  const length = channels[0]?.length ?? 0;
  const startFrame = Math.min(length, Math.max(0, Math.floor(fromSec * sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(length, Math.ceil(toSec * sampleRate)));
  return { startFrame, endFrame, channels: channels.map((c) => c.slice(startFrame, endFrame)) };
}

/**
 * The guide as mono samples starting at `startSec` of its sample (which may be before the sample begins: those samples are
 * silence) and lasting `durationSec`, at the guide's own sample rate.
 */
export function guideMono(channels: readonly Float32Array[], sampleRate: number, startSec: number, durationSec: number): Float32Array {
  const length = Math.max(0, Math.ceil(durationSec * sampleRate) + 1);
  const mono = new Float32Array(length);
  const source = channels[0]?.length ?? 0;
  const first = Math.round(startSec * sampleRate);
  const from = Math.max(0, -first);
  const to = Math.min(length, source - first);
  const gain = 1 / Math.max(1, channels.length);
  for (const channel of channels) {
    for (let i = from; i < to; i++) mono[i] = (mono[i] as number) + (channel[first + i] as number) * gain;
  }
  return mono;
}

/** An audible span cut to what exists: from 0 to the length of the stretch actually read (seconds). */
export function clampSpan(span: AudibleSpan, lengthSec: number): AudibleSpan {
  const fromSec = Math.min(lengthSec, Math.max(0, span.fromSec));
  return { fromSec, toSec: Math.max(fromSec, Math.min(lengthSec, span.toSec)) };
}
