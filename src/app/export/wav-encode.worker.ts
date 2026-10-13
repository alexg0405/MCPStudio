import { encodeWav } from '@core/io/wav';

// Encodes WAV off the main thread. The channel buffers are transferred in and the file is
// transferred back, so nothing large is copied.
interface Request {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  dither: boolean;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  try {
    const { channels, sampleRate, bitDepth, dither } = e.data;
    const bytes = encodeWav(channels, sampleRate, { bitDepth, dither, seed: 1 });
    scope.postMessage({ ok: true, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
