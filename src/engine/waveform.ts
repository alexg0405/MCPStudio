/**
 * Peak overview of a decoded sample for drawing: [min, max] per bucket of frames, over all
 * channels. Computed once per AudioBuffer.
 */
export interface Waveform {
  /** Interleaved min, max per bucket. */
  peaks: Float32Array;
  /** Frames per bucket. */
  bucket: number;
  sampleRate: number;
  duration: number;
}

const cache = new WeakMap<AudioBuffer, Waveform>();

export function waveformOf(buffer: AudioBuffer, bucket = 256): Waveform {
  const hit = cache.get(buffer);
  if (hit) return hit;
  const buckets = Math.max(1, Math.ceil(buffer.length / bucket));
  const peaks = new Float32Array(buckets * 2).fill(0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < buckets; b++) {
      let lo = peaks[b * 2] as number;
      let hi = peaks[b * 2 + 1] as number;
      const end = Math.min(data.length, (b + 1) * bucket);
      for (let i = b * bucket; i < end; i++) {
        const v = data[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      peaks[b * 2] = lo;
      peaks[b * 2 + 1] = hi;
    }
  }
  const w: Waveform = { peaks, bucket, sampleRate: buffer.sampleRate, duration: buffer.duration };
  cache.set(buffer, w);
  return w;
}
