import { monoReaderOf } from './mono';
import { frameGeometry, overlapAdd, similaritySearchFor, type StretchOptions } from './stretch';
import type { FrameTimeMap } from './time-map';

/**
 * A time map given as anchor points: output frame → input frame, increasing in both, joined by straight lines (so
 * the speed changes where the anchors do), plus stretches of the output that keep the input at its own speed (the
 * attacks that must not be smeared). Asked in increasing order of output frame, like the frame loop does.
 */
export class WarpTimeMap implements FrameTimeMap {
  private segment = 0;
  private zoneIndex = 0;

  /**
   * `outFrames[k]` plays input frame `inFrames[k]`; `keep` lists output spans [from, to] (frames, sorted, not
   * overlapping) in which the map has slope 1 and the overlap-add continues the input exactly.
   */
  constructor(
    private readonly outFrames: Float64Array,
    private readonly inFrames: Float64Array,
    private readonly keep: readonly { from: number; to: number }[] = [],
  ) {
    if (outFrames.length < 2 || outFrames.length !== inFrames.length) {
      throw new RangeError('WarpTimeMap needs at least two anchors, the same number for both frames.');
    }
  }

  inputFrameAt(o: number): number {
    const outs = this.outFrames;
    const ins = this.inFrames;
    while (this.segment < outs.length - 2 && o >= (outs[this.segment + 1] as number)) this.segment++;
    const o0 = outs[this.segment] as number;
    const o1 = outs[this.segment + 1] as number;
    const i0 = ins[this.segment] as number;
    const i1 = ins[this.segment + 1] as number;
    return o1 > o0 ? i0 + ((o - o0) * (i1 - i0)) / (o1 - o0) : i0;
  }

  zoneAt(o: number): number {
    while (this.zoneIndex < this.keep.length && (this.keep[this.zoneIndex] as { to: number }).to < o) this.zoneIndex++;
    const zone = this.keep[this.zoneIndex];
    return zone && o >= zone.from ? this.zoneIndex : -1;
  }
}

/**
 * Plays the input along a time map without changing its pitch (WSOLA, the same frames and search as the constant
 * `timeStretch`): the output has `outLength` frames, and each frame of it comes from where `map` says. Used by vocal
 * alignment, where the speed changes from syllable to syllable. The output goes to `sink` as it is finished.
 */
export function warpStream(
  channels: readonly Float32Array[],
  outLength: number,
  map: FrameTimeMap,
  opts: StretchOptions,
  sink: (at: number, chunk: readonly Float32Array[], n: number) => void,
): void {
  const inLen = channels[0]?.length ?? 0;
  if (inLen === 0 || outLength <= 0) return;
  const geometry = frameGeometry(opts);
  const readMono = monoReaderOf(channels, inLen);
  const search = similaritySearchFor(readMono, inLen, opts.sampleRate, geometry);
  overlapAdd(channels, { outLen: outLength, geometry, search, timeMap: map, sink });
}

/** `warpStream` collected into new channels of `outLength` frames. */
export function warpChannels(
  channels: readonly Float32Array[],
  outLength: number,
  map: FrameTimeMap,
  opts: StretchOptions,
): Float32Array[] {
  const outs = channels.map(() => new Float32Array(Math.max(0, outLength)));
  warpStream(channels, outLength, map, opts, (at, chunk, n) => {
    outs.forEach((out, c) => out.set((chunk[c] as Float32Array).subarray(0, n), at));
  });
  return outs;
}
