/**
 * Peak overview of a decoded sample for drawing: [min, max] per bucket of frames, over all
 * channels. Computed once per sample (SampleCache.loadWaveform, a slice at a time) and kept after
 * the decoded buffer is evicted.
 */
export interface Waveform {
  /** Interleaved min, max per bucket. */
  peaks: Float32Array;
  /** Frames per bucket. */
  bucket: number;
  sampleRate: number;
  duration: number;
}
