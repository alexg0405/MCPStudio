import { decodePcm, encodeWav } from '@core/io/wav';

// Reads WAV/AIFF files Chrome's decodeAudioData rejects (AIFF, unusual WAV variants) off the main
// thread: a long song would otherwise stall playback while it is parsed. Answers with the audio as
// 32-bit float WAV (which decodeAudioData reads and resamples) plus the file's own rate, or null.
interface Request {
  id: number;
  bytes: ArrayBuffer;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, bytes } = e.data;
  try {
    const pcm = decodePcm(new Uint8Array(bytes));
    if (!pcm || (pcm.channels[0]?.length ?? 0) === 0) {
      scope.postMessage({ id, wav: null });
      return;
    }
    const wav = encodeWav(pcm.channels, Math.round(pcm.sampleRate), { bitDepth: 32 });
    scope.postMessage({ id, wav: wav.buffer, sampleRate: pcm.sampleRate }, [wav.buffer as ArrayBuffer]);
  } catch {
    scope.postMessage({ id, wav: null });
  }
};
