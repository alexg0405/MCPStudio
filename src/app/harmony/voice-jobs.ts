import { renderHarmonyVoice } from '@core/harmony/voices';
import type { VoiceJob } from './voice.worker';

/** A voice render that failed in the Worker. */
export class VoiceJobError extends Error {}

/** Where the Worker reports back. */
type Reply = { id: number; ok: boolean; channels?: Float32Array[]; error?: string };

let sequence = 0;

/**
 * Renders a harmony voice in a Worker of its own (the audio in `job` is transferred: do not use it afterwards). Without Workers
 * (Node tests), or where one cannot start, it renders on the calling thread; the result is the same bits either way.
 */
export function renderVoice(job: VoiceJob): Promise<Float32Array[]> {
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => renderHarmonyVoice(job));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(renderHarmonyVoice(job));
      return;
    }
    worker.onmessage = (e: MessageEvent<Reply>) => {
      if (e.data.id !== id) return;
      worker.terminate();
      if (e.data.ok && e.data.channels) resolve(e.data.channels);
      else reject(new VoiceJobError(e.data.error ?? 'The harmony render failed.'));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new VoiceJobError(e.message || 'The harmony worker failed.'));
    };
    worker.postMessage({ ...job, id }, job.channels.map((c) => c.buffer as ArrayBuffer));
  });
}
