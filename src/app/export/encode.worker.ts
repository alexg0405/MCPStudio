import { encodeAudioAsync, type EncodeSpec } from './encode';

// Encodes WAV, FLAC or MP3 off the main thread. The channel buffers are transferred in and the file
// is transferred back, so nothing large is copied.
interface Request {
  channels: Float32Array[];
  sampleRate: number;
  spec: EncodeSpec;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = async (e) => {
  try {
    const { channels, sampleRate, spec } = e.data;
    const bytes = await encodeAudioAsync(channels, sampleRate, spec);
    scope.postMessage({ ok: true, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
