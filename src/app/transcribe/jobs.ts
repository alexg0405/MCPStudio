import type { Heard, ModeSuggestion } from '@core/audio/transcribe';
import { runTranscribeJob, type TranscribeJob, type TranscribeReply } from './job';

/** A job that failed in the Worker. */
export class TranscribeJobError extends Error {}

let sequence = 0;

/**
 * Runs a job in a Worker of its own (the audio is transferred: do not use it afterwards). Without Workers (Node tests), or
 * where one cannot start, it runs on the calling thread; the answer is the same either way.
 */
function run(job: TranscribeJob): Promise<{ heard?: Heard; suggestion?: ModeSuggestion }> {
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => runTranscribeJob(job));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(runTranscribeJob(job));
      return;
    }
    worker.onmessage = (e: MessageEvent<TranscribeReply>) => {
      if (e.data.id !== id) return;
      worker.terminate();
      if (e.data.ok) resolve(e.data);
      else reject(new TranscribeJobError(e.data.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new TranscribeJobError(e.message || 'The Convert to MIDI worker failed.'));
    };
    worker.postMessage({ ...job, id }, [job.mono.buffer as ArrayBuffer]);
  });
}

/** Listens to mono audio (starting `startSec` into its recording) for a mode. */
export async function listenInWorker(job: Omit<Extract<TranscribeJob, { kind: 'listen' }>, 'kind'>): Promise<Heard> {
  const answer = await run({ kind: 'listen', ...job });
  if (!answer.heard) throw new TranscribeJobError('Listening gave no answer.');
  return answer.heard;
}

/** Looks at mono audio and suggests a mode. */
export async function suggestInWorker(mono: Float32Array, sampleRate: number): Promise<ModeSuggestion> {
  const answer = await run({ kind: 'suggest', mono, sampleRate });
  if (!answer.suggestion) throw new TranscribeJobError('The look at the recording gave no answer.');
  return answer.suggestion;
}
