import { timeStretch } from '@core/audio/wsola';
import { encodePcm16 } from '@core/io/pcm16';

// Time-stretches audio off the main thread (WSOLA), one of a small pool (audio-buffers.ts). The
// channels are transferred in; the copy comes back as 16-bit PCM bytes (core/io/pcm16.ts, half the
// size of floats), which is also what is kept on disk, so a copy read back later is identical.
interface Request {
  id: number;
  channels: Float32Array[];
  scale: number;
  sampleRate: number;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, channels, scale, sampleRate } = e.data;
  try {
    const bytes = encodePcm16(timeStretch(channels, scale, { sampleRate }), sampleRate);
    scope.postMessage({ id, ok: true, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
