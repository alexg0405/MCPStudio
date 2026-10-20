import { renderCleanup, type CleanupResult } from '@core/audio/cleanup/render';
import type { VocalCleanup } from '@core/model/types';
import type { CleanupJobReply, CleanupJobRequest } from './cleanup.worker';

/** A cleanup job that failed (the message says why). */
export class CleanupJobError extends Error {}

/** A cleanup job that was stopped because a newer edit replaced it. */
export class CleanupJobCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** A job in flight. */
export interface RunningCleanupJob {
  result: Promise<CleanupResult>;
  /** Stops the job (its result rejects with CleanupJobCancelled). */
  cancel(): void;
}

let seq = 0;

/** The job on the calling thread (Node tests, or where a Worker cannot start). */
function inline(job: CleanupJobRequest, onProgress?: (fraction: number) => void): CleanupResult {
  return renderCleanup({ channels: job.channels, sampleRate: job.sampleRate, settings: job.settings, ...(onProgress ? { onProgress } : {}) });
}

/**
 * Renders a vocal cleanup in a Worker of its own (the audio is transferred: don't use it afterwards). Without Workers
 * (Node tests), or where one cannot start, it runs on the calling thread.
 */
export function renderCleanupInWorker(
  channels: Float32Array[],
  sampleRate: number,
  settings: VocalCleanup,
  onProgress?: (fraction: number) => void,
): RunningCleanupJob {
  const job: CleanupJobRequest = { channels, sampleRate, settings };
  if (typeof Worker === 'undefined') {
    return {
      result: new Promise((resolve, reject) =>
        queueMicrotask(() => {
          try {
            resolve(inline(job, onProgress));
          } catch (e) {
            reject(e);
          }
        }),
      ),
      cancel: () => {},
    };
  }
  let worker: Worker | null = null;
  let rejectAll: ((e: unknown) => void) | null = null;
  const result = new Promise<CleanupResult>((resolve, reject) => {
    rejectAll = reject;
    const id = ++seq;
    try {
      worker = new Worker(new URL('./cleanup.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      try {
        resolve(inline(job, onProgress));
      } catch (e) {
        reject(e);
      }
      return;
    }
    const w = worker;
    w.onmessage = (e: MessageEvent<CleanupJobReply & { progress?: number }>) => {
      if (e.data.id !== id) return;
      if (e.data.progress !== undefined) return void onProgress?.(e.data.progress);
      w.terminate();
      if (e.data.ok && e.data.channels && e.data.findings) resolve({ channels: e.data.channels, findings: e.data.findings });
      else reject(new CleanupJobError(e.data.error ?? 'The cleanup job failed.'));
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      reject(new CleanupJobError(e.message || 'The cleanup worker failed.'));
    };
    w.postMessage({ ...job, id }, channels.map((c) => c.buffer as ArrayBuffer));
  });
  return {
    result,
    cancel: () => {
      (worker as Worker | null)?.terminate();
      rejectAll?.(new CleanupJobCancelled());
    },
  };
}
