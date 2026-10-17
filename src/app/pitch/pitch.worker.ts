import { analyzePitch } from '@core/voice/pitch-notes';
import { renderPitchEdit } from '@core/audio/pitch-edit';
import type { PitchEdit } from '@core/model/types';

// Pitch analysis and the pitch-correction render, off the main thread (one Worker per job, so a long
// render never holds up an analysis). The audio is transferred in; results come back transferred.
export type PitchJob =
  | { kind: 'analyze'; mono: Float32Array; sampleRate: number; start: number }
  | { kind: 'render'; channels: Float32Array[]; sampleRate: number; start: number; edit: PitchEdit };

type Request = PitchJob & { id: number };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const job = e.data;
  try {
    if (job.kind === 'analyze') {
      const a = analyzePitch(job.mono, job.sampleRate, { start: job.start });
      scope.postMessage({ id: job.id, ok: true, analysis: a }, [a.f0.buffer as ArrayBuffer, a.conf.buffer as ArrayBuffer]);
    } else {
      const out = renderPitchEdit({
        channels: job.channels,
        sampleRate: job.sampleRate,
        start: job.start,
        edit: job.edit,
        onProgress: (fraction) => scope.postMessage({ id: job.id, progress: fraction }),
      });
      scope.postMessage({ id: job.id, ok: true, channels: out }, out.map((c) => c.buffer as ArrayBuffer));
    }
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
