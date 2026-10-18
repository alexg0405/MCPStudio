/** Helpers for the runner's audio blocks: peak measuring, copying and silent stand-in buffers. */

/** The longest block a silent buffer is allocated for at once (browsers use 128; offline renders may use more). */
const MAX_BLOCK_FRAMES = 4096;

/** Largest |sample| over the first n frames of the channels (an unconnected input has none: 0). */
export function peakOf(channels: readonly Float32Array[], n: number): number {
  let peak = 0;
  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c] as Float32Array;
    const end = Math.min(n, channel.length);
    for (let i = 0; i < end; i++) {
      const x = channel[i] as number;
      const magnitude = x < 0 ? -x : x;
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/** Copies n frames (the source may be longer than the block). */
export function copyInto(target: Float32Array, source: Float32Array, n: number): void {
  if (source.length === n) target.set(source);
  else for (let i = 0; i < n; i++) target[i] = source[i] as number;
}

/** Zeroed per-channel buffers of the current block size (views are rebuilt only when it changes). */
export class Silence {
  private readonly buffers: Float32Array[] = [];
  private readonly views: Float32Array[] = [];

  /** A zeroed buffer of `n` frames for `channel`. */
  get(channel: number, n: number): Float32Array {
    let view = this.views[channel];
    if (!view || view.length !== n) {
      let buffer = this.buffers[channel];
      if (!buffer || buffer.length < n) buffer = this.buffers[channel] = new Float32Array(Math.max(MAX_BLOCK_FRAMES, n));
      view = this.views[channel] = buffer.subarray(0, n);
    }
    // A kernel may have written into it last block.
    view.fill(0);
    return view;
  }
}
