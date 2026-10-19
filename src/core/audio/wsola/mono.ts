import type { MonoReader } from './onsets';

/**
 * A reader for the mono mix of the channels, which is never held whole: any window of it is made
 * from the channels on demand (zeros outside the signal), accumulated channel by channel in float
 * like an array of it would be. Mono is the channel itself, stereo the average of the two.
 */
export function monoReaderOf(channels: readonly Float32Array[], length: number): MonoReader {
  const channelCount = channels.length;
  const first = channels[0] as Float32Array;
  const second = channels[1] as Float32Array | undefined;
  return (dst, from, n) => {
    const lo = Math.max(0, -from);
    const hi = Math.min(n, length - from);
    if (lo > 0) dst.fill(0, 0, Math.min(n, lo));
    if (hi < n) dst.fill(0, Math.max(0, hi), n);
    if (channelCount === 1) {
      for (let j = lo; j < hi; j++) dst[j] = first[from + j] as number;
    } else if (channelCount === 2) {
      const right = second as Float32Array;
      for (let j = lo; j < hi; j++) {
        dst[j] = Math.fround(Math.fround((first[from + j] as number) + (right[from + j] as number)) / 2);
      }
    } else {
      for (let j = lo; j < hi; j++) {
        let mix = 0;
        for (let c = 0; c < channelCount; c++)
          mix = Math.fround(mix + ((channels[c] as Float32Array)[from + j] as number));
        dst[j] = Math.fround(mix / channelCount);
      }
    }
  };
}
