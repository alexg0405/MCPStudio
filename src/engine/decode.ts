import { decodePcm } from '@core/io/wav';

/**
 * Decodes an audio file. Chrome's decodeAudioData (which resamples to the context rate) reads WAV,
 * MP3, OGG, FLAC and M4A; files it rejects (AIFF, unusual WAV variants) fall back to the PCM parser
 * and keep their own rate (playback resamples). Throws when neither can read the bytes.
 */
export async function decodeAudio(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  try {
    // decodeAudioData detaches its input, so give it a copy.
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch (err) {
    const pcm = decodePcm(new Uint8Array(bytes));
    const length = pcm?.channels[0]?.length ?? 0;
    if (!pcm || length === 0) throw err;
    const buffer = new AudioBuffer({ length, numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate });
    pcm.channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    return buffer;
  }
}
