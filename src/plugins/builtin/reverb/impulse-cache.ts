import { generateReverbIR } from './ir.kernel';

/** How many impulse responses are kept (the most recently used ones). */
const CACHE_SIZE = 6;

/** Recently used impulse responses (AudioBuffers aren't tied to a context, so instances share them). */
const cache = new Map<string, AudioBuffer>();

/**
 * The stereo impulse response for these settings, generated the first time and then served from a small cache:
 * dragging a knob back and forth, or several Reverbs with the same settings, don't regenerate it.
 */
export function impulseResponse(sampleRate: number, decay: number, damping: number, size: number): AudioBuffer {
  const key = `${sampleRate}|${decay}|${damping}|${size}`;
  const hit = cache.get(key);
  if (hit) {
    // Re-insert so the Map's order stays "least recently used first".
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const [left, right] = generateReverbIR({ sampleRate, decay, damping, size });
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  cache.set(key, buffer);
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_SIZE) break;
    cache.delete(oldest);
  }
  return buffer;
}
