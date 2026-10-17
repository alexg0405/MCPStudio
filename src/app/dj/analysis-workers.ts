/**
 * Running track analyses in the analysis Worker (`analysis.worker.ts`): a song decoded whole is transferred in, a song read
 * by parts is sent chunk by chunk with flow control. Cancelling terminates the Worker; the next job makes a new one. Without
 * Workers (tests, odd environments) the same code runs on this thread.
 */
import type { TrackAnalysis } from '@core/dj/types';
import type { StreamRequest, WorkerReply } from './analysis-messages';
import { runAnalysis, type AnalysisJob } from './analysis-run';
import { driveAnalysis, inlineStreamTarget, type StreamSource, type StreamTarget } from './analysis-stream-run';

/** Runs one analysis job: in a Worker when there is one, else on this thread. Rejects with AbortError when cancelled. */
export type AnalysisRunner = (job: AnalysisJob, onProgress: (f: number) => void, signal: AbortSignal) => Promise<TrackAnalysis>;

/** Runs the analysis of a song read by parts: in a Worker when there is one, else on this thread. Rejects with AbortError when cancelled. */
export type StreamRunner = (hash: string, source: StreamSource, onProgress: (f: number) => void, signal: AbortSignal) => Promise<TrackAnalysis>;

export const abortError = () => new DOMException('The analysis was cancelled.', 'AbortError');

export const inlineRunner: AnalysisRunner = (job, onProgress, signal) =>
  new Promise((resolve, reject) => {
    // Let the caller's frame finish first.
    setTimeout(() => {
      if (signal.aborted) return reject(abortError());
      try {
        resolve(runAnalysis(job, { onProgress, isCancelled: () => signal.aborted }));
      } catch (e) {
        reject(signal.aborted ? abortError() : e);
      }
    }, 0);
  });

export const inlineStreamRunner: StreamRunner = (hash, source, onProgress, signal) =>
  driveAnalysis(hash, source, inlineStreamTarget({ signal }), { signal, onProgress });

/** The analysis Worker, made when first needed and made again after it was terminated (a cancelled job). */
export interface WorkerHost {
  get(): Worker;
  drop(): void;
  nextId(): number;
}

export function workerHost(): WorkerHost {
  let worker: Worker | null = null;
  let seq = 0;
  return {
    get() {
      worker ??= new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      return worker;
    },
    drop() {
      worker?.terminate();
      worker = null;
    },
    nextId: () => ++seq,
  };
}

export function workerRunner(host: WorkerHost): AnalysisRunner {
  return (job, onProgress, signal) => {
    if (typeof Worker === 'undefined') return inlineRunner(job, onProgress, signal);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      let w: Worker;
      try {
        w = host.get();
      } catch {
        return resolve(inlineRunner(job, onProgress, signal));
      }
      const id = host.nextId();
      const done = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onMessage = (e: MessageEvent<WorkerReply>) => {
        if (e.data.id !== id) return;
        if (e.data.type === 'progress') onProgress(e.data.fraction);
        else if (e.data.type === 'done') {
          done();
          resolve(e.data.analysis);
        } else if (e.data.type === 'error') {
          done();
          reject(new Error(e.data.message || 'The track analysis failed.'));
        }
      };
      const onError = (e: ErrorEvent) => {
        done();
        host.drop();
        reject(new Error(e.message || 'The track analysis worker failed.'));
      };
      // Cancelling stops the computation at once: the Worker goes, the next job makes a new one.
      const onAbort = () => {
        done();
        host.drop();
        reject(abortError());
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort);
      w.postMessage({ id, ...job }, job.channels.map((c) => c.buffer as ArrayBuffer));
    });
  };
}

/** Chunks the Worker may be holding at once (each is acknowledged when worked on): reading stays this far ahead and no further. */
export const MAX_IN_FLIGHT = 3;

export function workerStreamRunner(host: WorkerHost): StreamRunner {
  return async (hash, source, onProgress, signal) => {
    if (typeof Worker === 'undefined') return inlineStreamRunner(hash, source, onProgress, signal);
    if (signal.aborted) throw abortError();
    let w: Worker;
    try {
      w = host.get();
    } catch {
      return inlineStreamRunner(hash, source, onProgress, signal);
    }
    const id = host.nextId();
    let failure: Error | null = null;
    let inFlight = 0;
    let wake: (() => void) | null = null;
    let finishing: { resolve(a: TrackAnalysis): void; reject(e: Error): void; progress(f: number): void } | null = null;
    const fail = (e: Error) => {
      failure ??= e;
      wake?.();
      finishing?.reject(e);
    };
    const onMessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'ack') {
        inFlight--;
        wake?.();
      } else if (m.type === 'progress') finishing?.progress(m.fraction);
      else if (m.type === 'done') finishing?.resolve(m.analysis);
      else fail(new Error(m.message || 'The track analysis failed.'));
    };
    const onError = (e: ErrorEvent) => {
      host.drop();
      fail(new Error(e.message || 'The track analysis worker failed.'));
    };
    const onAbort = () => {
      host.drop();
      fail(abortError());
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);
    const post = (m: StreamRequest, transfer: Transferable[] = []) => w.postMessage(m, transfer);
    const send = (kind: 'stream-scan' | 'stream-chunk') => async (l: Float32Array, r: Float32Array | null) => {
      while (inFlight >= MAX_IN_FLIGHT && !failure) await new Promise<void>((resolve) => (wake = resolve));
      if (failure) throw failure;
      inFlight++;
      post({ kind, id, l, r }, r ? [l.buffer, r.buffer] : [l.buffer]);
    };
    const target: StreamTarget = {
      start: (info) => post({ kind: 'stream-start', id, info }),
      startRegion: () => post({ kind: 'stream-region', id }),
      scan: send('stream-scan'),
      chunk: send('stream-chunk'),
      finish: (progress) =>
        new Promise<TrackAnalysis>((resolve, reject) => {
          if (failure) return reject(failure);
          finishing = { resolve, reject, progress };
          post({ kind: 'stream-end', id });
        }),
    };
    let ok = false;
    try {
      const analysis = await driveAnalysis(hash, source, target, { signal, onProgress });
      ok = true;
      return analysis;
    } finally {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      // A run that stopped half way (unreadable file, cancel) leaves the Worker holding a part of the song's features: it goes.
      if (!ok) host.drop();
    }
  };
}
