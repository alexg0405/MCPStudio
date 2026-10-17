import { analyzePitch, type PitchAnalysis } from '@core/voice/pitch-notes';
import { renderPitchEdit } from '@core/audio/pitch-edit';
import type { PitchJob } from './pitch.worker';

export class PitchJobError extends Error {}
export class PitchJobCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface RunningPitchJob<T> {
  result: Promise<T>;
  /** Stops the job (its result rejects with PitchJobCancelled). */
  cancel(): void;
}

let seq = 0;

type Reply = { id: number; ok?: boolean; progress?: number; analysis?: PitchAnalysis; channels?: Float32Array[]; error?: string };

function inline(job: PitchJob, onProgress?: (fraction: number) => void): PitchAnalysis | Float32Array[] {
  if (job.kind === 'analyze') return analyzePitch(job.mono, job.sampleRate, { start: job.start });
  return renderPitchEdit({
    channels: job.channels,
    sampleRate: job.sampleRate,
    start: job.start,
    edit: job.edit,
    ...(onProgress ? { onProgress } : {}),
  });
}

/**
 * Runs a job in a Worker of its own (the audio is transferred: don't use it afterwards). Without
 * Workers (Node tests), or where one cannot start, it runs on the calling thread.
 */
function run(job: PitchJob, onProgress?: (fraction: number) => void): RunningPitchJob<unknown> {
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
  const result = new Promise<unknown>((resolve, reject) => {
    rejectAll = reject;
    const id = ++seq;
    try {
      worker = new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      try {
        resolve(inline(job, onProgress));
      } catch (e) {
        reject(e);
      }
      return;
    }
    const w = worker;
    w.onmessage = (e: MessageEvent<Reply>) => {
      if (e.data.id !== id) return;
      if (e.data.progress !== undefined) return void onProgress?.(e.data.progress);
      w.terminate();
      if (e.data.ok) resolve(job.kind === 'analyze' ? e.data.analysis : e.data.channels);
      else reject(new PitchJobError(e.data.error ?? 'The pitch job failed.'));
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      reject(new PitchJobError(e.message || 'The pitch worker failed.'));
    };
    const transfer: Transferable[] =
      job.kind === 'analyze' ? [job.mono.buffer as ArrayBuffer] : job.channels.map((c) => c.buffer as ArrayBuffer);
    w.postMessage({ ...job, id }, transfer);
  });
  return {
    result,
    cancel: () => {
      (worker as Worker | null)?.terminate();
      rejectAll?.(new PitchJobCancelled());
    },
  };
}

/** Tracks and segments the pitch of mono audio that starts `start` seconds into its sample. */
export function analyzeInWorker(mono: Float32Array, sampleRate: number, start: number): RunningPitchJob<PitchAnalysis> {
  return run({ kind: 'analyze', mono, sampleRate, start }) as RunningPitchJob<PitchAnalysis>;
}

/** Renders a pitch edit over a stretch of a sample (channels transferred). Resolves with the corrected channels. */
export function renderInWorker(
  channels: Float32Array[],
  sampleRate: number,
  start: number,
  edit: Extract<PitchJob, { kind: 'render' }>['edit'],
  onProgress?: (fraction: number) => void,
): RunningPitchJob<Float32Array[]> {
  return run({ kind: 'render', channels, sampleRate, start, edit }, onProgress) as RunningPitchJob<Float32Array[]>;
}
