import { decodePcm } from '@core/io/wav';

let pcmWorker: Worker | null = null;
let pcmSeq = 0;
const pcmJobs = new Map<number, (wav: ArrayBuffer | null) => void>();

/** Parses a WAV/AIFF file the browser rejected into float WAV bytes, in a Worker (null: not PCM). */
function pcmToWav(bytes: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  if (!pcmWorker) {
    try {
      pcmWorker = new Worker(new URL('./pcm.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return Promise.resolve(null);
    }
    pcmWorker.onmessage = (e: MessageEvent<{ id: number; wav: ArrayBuffer | null }>) => {
      pcmJobs.get(e.data.id)?.(e.data.wav);
      pcmJobs.delete(e.data.id);
    };
    pcmWorker.onerror = () => {
      for (const done of pcmJobs.values()) done(null);
      pcmJobs.clear();
      pcmWorker?.terminate();
      pcmWorker = null;
    };
  }
  const id = ++pcmSeq;
  const w = pcmWorker;
  return new Promise((resolve) => {
    pcmJobs.set(id, resolve);
    const copy = bytes.slice(0);
    w.postMessage({ id, bytes: copy }, [copy]);
  });
}

/**
 * Decodes an audio file. Chrome's decodeAudioData (off the main thread; it resamples to the context
 * rate) reads WAV, MP3, OGG, FLAC and M4A. Files it rejects (AIFF, unusual WAV variants) go through
 * our PCM parser in a Worker and come back as float WAV for decodeAudioData, so they are resampled
 * the same way; without Workers (or if that fails too) the parser's audio is used at the file's own
 * rate (playback resamples). Throws when nothing can read the bytes.
 */
export async function decodeAudio(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  try {
    // decodeAudioData detaches its input, so give it a copy.
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch (err) {
    const wav = await pcmToWav(bytes);
    if (wav) {
      try {
        return await ctx.decodeAudioData(wav);
      } catch {
        /* fall through to the parser on this thread */
      }
    }
    const pcm = decodePcm(new Uint8Array(bytes));
    const length = pcm?.channels[0]?.length ?? 0;
    if (!pcm || length === 0) throw err;
    const buffer = new AudioBuffer({ length, numberOfChannels: pcm.channels.length, sampleRate: pcm.sampleRate });
    pcm.channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    return buffer;
  }
}
