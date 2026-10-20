/**
 * The time-warp render of alignment: plays the clip's own sound along the lag curve (output time o plays the clip from
 * o + lag(o)) with WSOLA, so the pitch stays and the syllables move. Attacks that were kept (`KeptSpan`) play at their
 * own speed with the overlap-add continuing the input exactly, so a consonant is moved, never smeared. The output is
 * as long as the input.
 */
import { WarpTimeMap, warpChannels } from '../wsola/warp';
import type { KeptSpan } from './lag';

/** The frame length the warp uses: short enough to follow a syllable's change of speed (milliseconds). */
const WARP_FRAME_MS = 30;
/** How far a frame may move to continue the one before it (milliseconds). */
const WARP_TOLERANCE_MS = 8;
/**
 * How long before an attack the sound must already play at its own speed (seconds): every frame that reaches the attack
 * must be one that continues the input exactly, or its copy of the attack would be found a few milliseconds early (a
 * frame, plus half a frame of hop, plus the search tolerance).
 */
export const KEEP_BEFORE_ATTACK_SEC = (WARP_FRAME_MS * 1.5 + WARP_TOLERANCE_MS) / 1000;
/** …and how long after it (half a frame plus the tolerance, and the attack itself). */
export const KEEP_AFTER_ATTACK_SEC = Math.max(0.04, (WARP_FRAME_MS * 0.5 + WARP_TOLERANCE_MS) / 1000);

/**
 * Renders the clip along `lag` (seconds per frame of `hopSec`, the first frame at output time 0). Deterministic: the
 * same input gives the same samples. Returns new channels as long as the input.
 */
export function renderLag(
  channels: readonly Float32Array[],
  sampleRate: number,
  lag: Float32Array,
  hopSec: number,
  kept: readonly KeptSpan[],
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return channels.map((c) => Float32Array.from(c));
  const isFlat = lag.every((v) => Math.abs(v) < 1e-9);
  if (isFlat) return channels.map((c) => Float32Array.from(c));
  const outFrames = new Float64Array(lag.length + 1);
  const inFrames = new Float64Array(lag.length + 1);
  for (let k = 0; k < lag.length; k++) {
    outFrames[k] = k * hopSec * sampleRate;
    inFrames[k] = (outFrames[k] as number) + (lag[k] as number) * sampleRate;
  }
  // One more anchor at the end of the output, carrying the last lag on.
  const end = Math.max(length, (outFrames[lag.length - 1] as number) + 1);
  outFrames[lag.length] = end;
  inFrames[lag.length] = end + (lag[lag.length - 1] as number) * sampleRate;
  const spans = kept.map((s) => ({ from: s.fromSec * sampleRate, to: s.toSec * sampleRate }));
  const map = new WarpTimeMap(outFrames, inFrames, spans);
  return warpChannels(channels, length, map, {
    sampleRate,
    frameMs: WARP_FRAME_MS,
    toleranceMs: WARP_TOLERANCE_MS,
    transients: false,
  });
}
