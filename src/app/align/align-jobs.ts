import { runAlignJob, type AlignJob, type AlignJobResult } from './run';

export class AlignJobError extends Error {}
export class AlignJobCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** An alignment running somewhere: its result, and a way to stop it (the result then rejects with `AlignJobCancelled`). */
export interface RunningAlignJob {
  result: Promise<AlignJobResult>;
  cancel(): void;
}

let sequence = 0;

type Reply = { id: number; ok?: boolean; progress?: number; result?: AlignJobResult; error?: string };

/** The job on the calling thread (no Workers in Node tests; a fallback where one cannot start). */
function inline(job: AlignJob, onProgress?: (fraction: number) => void): RunningAlignJob {
  return {
    result: new Promise((resolve, reject) =>
      queueMicrotask(() => {
        try {
          resolve(runAlignJob(job, onProgress));
        } catch (e) {
          reject(e);
        }
      }),
    ),
    cancel: () => {},
  };
}

/**
 * Runs a job in a Worker of its own (the audio is transferred: do not use it afterwards). Without Workers (Node tests), or
 * where one cannot start, it runs on the calling thread.
 */
export function runAlignInWorker(job: AlignJob, onProgress?: (fraction: number) => void): RunningAlignJob {
  if (typeof Worker === 'undefined') return inline(job, onProgress);
  let worker: Worker | null = null;
  let rejectAll: ((e: unknown) => void) | null = null;
  const result = new Promise<AlignJobResult>((resolve, reject) => {
    rejectAll = reject;
    const id = ++sequence;
    try {
      worker = new Worker(new URL('./align.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      inline(job, onProgress).result.then(resolve, reject);
      return;
    }
    const w = worker;
    w.onmessage = (e: MessageEvent<Reply>) => {
      if (e.data.id !== id) return;
      if (e.data.progress !== undefined) return void onProgress?.(e.data.progress);
      w.terminate();
      if (e.data.ok && e.data.result) resolve(e.data.result);
      else reject(new AlignJobError(e.data.error ?? 'The alignment failed.'));
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      reject(new AlignJobError(e.message || 'The alignment worker failed.'));
    };
    const transfer: Transferable[] = job.channels.map((c) => c.buffer as ArrayBuffer);
    if (job.kind === 'guide') transfer.push(job.guide.mono.buffer as ArrayBuffer);
    w.postMessage({ ...job, id }, transfer);
  });
  return {
    result,
    cancel: () => {
      (worker as Worker | null)?.terminate();
      rejectAll?.(new AlignJobCancelled());
    },
  };
}
