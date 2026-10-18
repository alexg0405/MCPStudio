// Main-thread side of the built-in textures: made once per page, on first use, and shared with every kernel.
import { buildTexture } from './textures.kernel';

const cache = new Map<string, Float32Array[]>();

/** A Float32Array that kernels can read without a copy when the page allows shared memory (dev and preview servers do). */
function shared(source: Float32Array): Float32Array {
  const canShare =
    typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!canShare) return source;
  const copy = new Float32Array(new SharedArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

/** The two channels of a built-in texture (built the first time it is asked for: about 30 ms). */
export function textureChannels(id: string): Float32Array[] {
  let channels = cache.get(id);
  if (!channels) {
    channels = buildTexture(id).map(shared);
    cache.set(id, channels);
  }
  return channels;
}
