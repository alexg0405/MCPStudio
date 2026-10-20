import { renderCleanup, type CleanupFindings } from '@core/audio/cleanup/render';
import type { VocalCleanup } from '@core/model/types';

// The vocal cleanup render, off the main thread (one Worker per job). The audio is transferred in; the cleaned audio
// comes back transferred, with what the render found (the quiet stretch, the breaths).
export interface CleanupJobRequest {
  channels: Float32Array[];
  sampleRate: number;
  settings: VocalCleanup;
}

/** The answer of a finished job. */
export interface CleanupJobReply {
  id: number;
  ok: boolean;
  channels?: Float32Array[];
  findings?: CleanupFindings;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CleanupJobRequest & { id: number }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const job = e.data;
  try {
    const result = renderCleanup({
      channels: job.channels,
      sampleRate: job.sampleRate,
      settings: job.settings,
      onProgress: (fraction) => scope.postMessage({ id: job.id, progress: fraction }),
    });
    scope.postMessage({ id: job.id, ok: true, channels: result.channels, findings: result.findings }, result.channels.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
