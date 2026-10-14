import { timeStretch } from '@core/audio/wsola';

// Time-stretches audio off the main thread (WSOLA). Channels are transferred in and out.
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
    const out = timeStretch(channels, scale, { sampleRate });
    scope.postMessage({ id, ok: true, channels: out }, out.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
