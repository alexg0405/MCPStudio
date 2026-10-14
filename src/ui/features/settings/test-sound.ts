import { encodeWav } from '@core/io/wav';

/**
 * A short two-note chime: the first note in the left speaker, the second in the right, so you hear
 * which output is playing and that left and right are the right way round. A WAV file's bytes.
 */
export function testSoundWav(sampleRate = 48000): Uint8Array {
  const length = Math.round(sampleRate * 1.4);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const ding = (out: Float32Array, at: number, freq: number) => {
    const start = Math.round(at * sampleRate);
    for (let i = 0; start + i < length; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.004) * Math.exp(-t * 7);
      const w = 2 * Math.PI * freq * t;
      out[start + i] = 0.3 * env * (Math.sin(w) + 0.25 * Math.sin(2 * w) + 0.08 * Math.sin(3 * w));
    }
  };
  ding(left, 0, 880);
  ding(right, 0.4, 660);
  return encodeWav([left, right], sampleRate, { bitDepth: 16 });
}
