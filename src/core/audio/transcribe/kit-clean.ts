/**
 * Taking a coincident drum out of a pad's example. A clap that is always on a kick, a snare that always has a hat over it:
 * the best example of the clap still has the kick in it, and played with the kick it would sound doubled. When another kind
 * has a clean example of its own (no hit sounding with it), the loudest fit of that example (least squares over its first
 * stretch) is subtracted from the cut. What is left is the clap (and whatever the example did not explain). Pure.
 */
import type { CoincidentHit, DrumKind } from './types';

/** One pad's example cut: its kind, what sounds with it, and its audio (a channel per entry). */
export interface PadCut {
  kind: DrumKind;
  with?: readonly CoincidentHit[];
  channels: Float32Array[];
}

/** How much of the other example is fitted and subtracted (s): its attack and body, where the coincident sound is. */
const FIT_SEC = 0.15;
/** The most the example may be turned up to fit (a hit harder than the example's own). */
const MAX_GAIN = 1.6;
/** How far the example is slid either way to line up with the hit (s): starts are found to a few milliseconds, and a kick's 50 Hz cycle is 20 ms. */
const ALIGN_SEC = 0.005;

/** A cut with the clean examples of the kinds sounding with it taken out. Cuts without coincident hits come back as they are. */
export function cleanCuts(cuts: readonly PadCut[], sampleRate: number): Float32Array[][] {
  const clean = cuts.filter((cut) => !cut.with || cut.with.length === 0);
  return cuts.map((cut) => {
    if (!cut.with || cut.with.length === 0) return cut.channels;
    let channels: Float32Array[] = cut.channels.map((c) => Float32Array.from(c));
    for (const other of cut.with) {
      const example = clean.find((c) => c.kind === other.kind);
      if (!example) continue;
      const fit = Math.round(FIT_SEC * sampleRate);
      const offset = alignedOffset(channels, example.channels, Math.round(other.deltaSec * sampleRate), fit, Math.round(ALIGN_SEC * sampleRate));
      channels = subtractExample(channels, example.channels, offset, fit);
    }
    return channels;
  });
}

/** How well the example fits the cut at an offset: the part of the cut it explains (dot² over example energy), summed over channels. */
function fitScore(channels: Float32Array[], example: readonly Float32Array[], offset: number, fitFrames: number): number {
  let dot = 0;
  let energy = 0;
  for (let c = 0; c < Math.min(channels.length, example.length); c++) {
    const target = channels[c] as Float32Array;
    const part = example[c] as Float32Array;
    for (let i = 0; i < Math.min(part.length, fitFrames); i++) {
      const at = offset + i;
      if (at < 0 || at >= target.length) continue;
      dot += (target[at] as number) * (part[i] as number);
      energy += (part[i] as number) * (part[i] as number);
    }
  }
  return dot > 0 && energy > 0 ? (dot * dot) / energy : 0;
}

/** The offset near `offset` (within `reach` frames either way) where the example explains most of the cut. */
function alignedOffset(channels: Float32Array[], example: readonly Float32Array[], offset: number, fitFrames: number, reach: number): number {
  let best = offset;
  let bestScore = -1;
  for (let lag = -reach; lag <= reach; lag++) {
    const score = fitScore(channels, example, offset + lag, fitFrames);
    if (score > bestScore) {
      bestScore = score;
      best = offset + lag;
    }
  }
  return best;
}

/** `channels` less the best fit of `example` that starts `offset` frames into them (all channels share one gain). */
function subtractExample(channels: Float32Array[], example: readonly Float32Array[], offset: number, fitFrames: number): Float32Array[] {
  let dot = 0;
  let energy = 0;
  const channelCount = Math.min(channels.length, example.length);
  for (let c = 0; c < channelCount; c++) {
    const target = channels[c] as Float32Array;
    const part = example[c] as Float32Array;
    for (let i = 0; i < Math.min(part.length, fitFrames); i++) {
      const at = offset + i;
      if (at < 0 || at >= target.length) continue;
      dot += (target[at] as number) * (part[i] as number);
      energy += (part[i] as number) * (part[i] as number);
    }
  }
  if (!(energy > 0)) return channels;
  const gain = Math.max(0, Math.min(MAX_GAIN, dot / energy));
  for (let c = 0; c < channelCount; c++) {
    const target = channels[c] as Float32Array;
    const part = example[c] as Float32Array;
    for (let i = 0; i < part.length; i++) {
      const at = offset + i;
      if (at >= 0 && at < target.length) target[at] = (target[at] as number) - gain * (part[i] as number);
    }
  }
  return channels;
}
