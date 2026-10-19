import { renderHarmonyVoice, type VoiceRenderInput } from '@core/harmony/voices';

// A harmony voice's render, off the main thread (one Worker per voice, so voices render side by side). The audio is
// transferred in; the result comes back transferred.
export type VoiceJob = Omit<VoiceRenderInput, 'onProgress'>;

type Request = VoiceJob & { id: number };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { id, ...job } = e.data;
  try {
    const out = renderHarmonyVoice(job);
    scope.postMessage({ id, ok: true, channels: out }, out.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
