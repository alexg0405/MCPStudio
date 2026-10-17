/**
 * WSOLA straight into the 16-bit container (`core/io/pcm16.ts`) that stretched copies are kept in. The
 * output goes in as it is finished, so the song never exists as floats a second time: a stretch Worker
 * holds the input channels, this container (half the size of floats) and a few kilobytes of working
 * space, where it held the input, a mono mix, the whole float output and then the container as well.
 *
 * The container has one gain for the whole copy (`sample = int16 / 32767 × gain`, so a master that goes over
 * full scale isn't clipped), and it is in the header, ahead of the audio. The output of WSOLA is a weighted
 * average of input samples whose weights add up to 1, so it never goes over the input's peak: the gain
 * is chosen from the input before the stretch starts (1 unless the input itself goes over). The old way chose
 * it from the output's own peak, which is the same number for anything that stays within full scale and a
 * little smaller for a file that doesn't; the decoded samples differ by at most one step of the larger gain.
 */
import { createPcm16, quantizePcm16 } from '@core/io/pcm16';
import { stretchStream, type StretchOptions } from '@core/audio/wsola';

/** `encodePcm16(timeStretch(channels, scale, opts), opts.sampleRate)` without the float output. */
export function stretchToPcm16(channels: readonly Float32Array[], scale: number, opts: StretchOptions): Uint8Array {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('timeStretch: the scale must be a positive number.');
  const inLen = channels[0]?.length ?? 0;
  const outLen = Math.max(0, Math.round(inLen * scale));
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i] as number));
  const gain = Math.fround(peak > 1 ? peak : 1);
  const { bytes, pcm } = createPcm16(channels.length, outLen, opts.sampleRate, gain);
  const k = 32767 / gain;
  stretchStream(channels, scale, opts, (at, chunk, n) => {
    for (let ch = 0; ch < chunk.length; ch++) {
      const src = chunk[ch] as Float32Array;
      const o = ch * outLen + at;
      for (let i = 0; i < n; i++) pcm[o + i] = quantizePcm16(src[i] as number, k);
    }
  });
  return bytes;
}
