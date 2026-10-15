/**
 * Track analyses by content hash: computed in a Worker the first time a song is looked at, stored so
 * it is never computed twice (survives reloads), and shared by the library, the auto-mix and the decks.
 * (The analysis itself lives in core/dj; this is the cache and the entry point the UI and actions call.)
 */
import type { SampleRef } from '@core/model/types';
import { ANALYSIS_VERSION, type TrackAnalysis } from '@core/dj/types';
import { decodeAudio } from '@engine/decode';
import { idbDel, idbGet, idbKeys, idbSet, isIdbAvailable } from '@platform/idb';
import { opfsSampleProvider } from '../persistence/project-io';
import type { Services } from '../services';
import { runAnalysis, type AnalysisJob } from './analysis-run';

export interface AnalysisProgress {
  hash: string;
  /** 0–1 */
  fraction: number;
}

export interface TrackAnalyzer {
  /** The cached analysis, or null (not analyzed yet). */
  peek(hash: string): TrackAnalysis | null;
  /** The analysis: cached, or computed now (the file is decoded and analyzed off the main thread). */
  analyze(s: Services, ref: SampleRef, opts?: { signal?: AbortSignal; onProgress?(p: AnalysisProgress): void }): Promise<TrackAnalysis>;
  /** Called when any analysis is added (the library redraws). */
  subscribe(fn: () => void): () => void;
}

/** The cache key of a sample: its content hash (embedded files) or its generator (built-in sounds). */
export function analysisHash(ref: Pick<SampleRef, 'source'>): string {
  const src = ref.source;
  return src.kind === 'embedded' ? src.hash : `builtin:${src.generator}@${src.version}`;
}

/** Where analyses are kept between sessions. */
export interface AnalysisStorage {
  /** Every stored analysis of the current version (older versions may be dropped). */
  load(): Promise<TrackAnalysis[]>;
  save(a: TrackAnalysis): Promise<void>;
}

const PREFIX = 'dj-analysis:';
const keyOf = (hash: string) => `${PREFIX}v${ANALYSIS_VERSION}:${hash}`;

const isAnalysis = (x: unknown): x is TrackAnalysis => {
  const a = x as Partial<TrackAnalysis> | null;
  return !!a && a.version === ANALYSIS_VERSION && typeof a.hash === 'string' && Array.isArray(a.energy) && Array.isArray(a.sections);
};

/** IndexedDB (the app's key-value store), one entry per song; entries of older analysis versions are deleted. */
export const idbAnalysisStorage: AnalysisStorage = {
  async load() {
    if (!isIdbAvailable()) return [];
    const keys = (await idbKeys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX));
    const current = `${PREFIX}v${ANALYSIS_VERSION}:`;
    const out: TrackAnalysis[] = [];
    for (const k of keys) {
      if (!k.startsWith(current)) {
        void idbDel(k).catch(() => {});
        continue;
      }
      const v = await idbGet(k);
      if (isAnalysis(v)) out.push(v);
    }
    return out;
  },
  save: (a) => (isIdbAvailable() ? idbSet(keyOf(a.hash), a) : Promise.resolve()),
};

export function memoryAnalysisStorage(initial: TrackAnalysis[] = []): AnalysisStorage & { items: Map<string, TrackAnalysis> } {
  const items = new Map(initial.map((a) => [a.hash, a]));
  return {
    items,
    load: () => Promise.resolve([...items.values()].filter(isAnalysis)),
    save: (a) => {
      items.set(a.hash, structuredClone(a));
      return Promise.resolve();
    },
  };
}

/** Decoded audio for the analysis (up to two channels, copies the analysis may keep). */
export type AnalysisDecoder = (s: Services, ref: SampleRef) => Promise<{ channels: Float32Array[]; sampleRate: number } | null>;

/** The analysis rate the files are decoded at (decodeAudioData resamples to it). */
const DECODE_RATE = 44100;

/**
 * Embedded files: their bytes from the sample store, decoded at 44.1 kHz (this decode isn't kept, so a
 * library scan doesn't fill the engine's cache). Built-in sounds: the engine's decoded copy.
 */
export const defaultDecoder: AnalysisDecoder = async (s, ref) => {
  if (ref.source.kind === 'embedded' && typeof OfflineAudioContext !== 'undefined') {
    const bytes = await opfsSampleProvider().getBytes(ref);
    if (bytes) {
      const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
      const buffer = await decodeAudio(ctx, bytes);
      const n = Math.min(2, buffer.numberOfChannels);
      return { channels: Array.from({ length: n }, (_, c) => buffer.getChannelData(c).slice()), sampleRate: buffer.sampleRate };
    }
  }
  const data = await s.engine.sampleData(ref);
  if (!data) return null;
  return { channels: data.channels.slice(0, 2).map((c) => c.slice()), sampleRate: data.sampleRate };
};

/** Runs one analysis job: in a Worker when there is one, else on this thread. Rejects with AbortError when cancelled. */
export type AnalysisRunner = (job: AnalysisJob, onProgress: (f: number) => void, signal: AbortSignal) => Promise<TrackAnalysis>;

const abortError = () => new DOMException('The analysis was cancelled.', 'AbortError');

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

function workerRunner(): AnalysisRunner {
  let worker: Worker | null = null;
  let seq = 0;
  return (job, onProgress, signal) => {
    if (typeof Worker === 'undefined') return inlineRunner(job, onProgress, signal);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      try {
        worker ??= new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        return resolve(inlineRunner(job, onProgress, signal));
      }
      const w = worker;
      const id = ++seq;
      const done = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onMessage = (e: MessageEvent<{ id: number; type: string; fraction?: number; analysis?: TrackAnalysis; message?: string }>) => {
        if (e.data.id !== id) return;
        if (e.data.type === 'progress') onProgress(e.data.fraction ?? 0);
        else if (e.data.type === 'done' && e.data.analysis) {
          done();
          resolve(e.data.analysis);
        } else if (e.data.type === 'error') {
          done();
          reject(new Error(e.data.message ?? 'The track analysis failed.'));
        }
      };
      const onError = (e: ErrorEvent) => {
        done();
        worker?.terminate();
        worker = null;
        reject(new Error(e.message || 'The track analysis worker failed.'));
      };
      // Cancelling stops the computation at once: the Worker goes, the next job makes a new one.
      const onAbort = () => {
        done();
        worker?.terminate();
        worker = null;
        reject(abortError());
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort);
      w.postMessage({ id, ...job }, job.channels.map((c) => c.buffer as ArrayBuffer));
    });
  };
}

interface Job {
  hash: string;
  promise: Promise<TrackAnalysis>;
  controller: AbortController;
  waiting: number;
  listeners: Set<(p: AnalysisProgress) => void>;
}

export interface TrackAnalyzerOptions {
  storage?: AnalysisStorage;
  decode?: AnalysisDecoder;
  run?: AnalysisRunner;
}

/**
 * The analyzer: one song at a time (a queue), callers asking for the same song share its job, and a
 * job is cancelled when every caller waiting for it has aborted.
 */
export function createTrackAnalyzer(opts: TrackAnalyzerOptions = {}): TrackAnalyzer & { ready: Promise<void> } {
  const storage = opts.storage ?? idbAnalysisStorage;
  const decode = opts.decode ?? defaultDecoder;
  const run = opts.run ?? workerRunner();
  const cache = new Map<string, TrackAnalysis>();
  const jobs = new Map<string, Job>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  let queue: Promise<unknown> = Promise.resolve();

  const ready = storage
    .load()
    .then((list) => {
      let added = false;
      for (const a of list)
        if (!cache.has(a.hash)) {
          cache.set(a.hash, a);
          added = true;
        }
      if (added) emit();
    })
    .catch(() => {});

  const start = (s: Services, ref: SampleRef, hash: string): Job => {
    const controller = new AbortController();
    const job: Job = { hash, controller, waiting: 0, listeners: new Set(), promise: Promise.resolve(null as never) };
    const progress = (fraction: number) => job.listeners.forEach((fn) => fn({ hash, fraction }));
    const work = async () => {
      await ready;
      const hit = cache.get(hash);
      if (hit) return hit;
      controller.signal.throwIfAborted();
      progress(0);
      const audio = await decode(s, ref);
      if (!audio || (audio.channels[0]?.length ?? 0) === 0) throw new Error(`“${ref.name}” couldn’t be decoded for analysis.`);
      controller.signal.throwIfAborted();
      progress(0.05);
      const analysis = await run({ hash, ...audio }, (f) => progress(0.05 + 0.95 * f), controller.signal);
      cache.set(hash, analysis);
      void storage.save(analysis).catch((e: unknown) => console.warn('[agstudio] saving a track analysis failed', e));
      progress(1);
      emit();
      return analysis;
    };
    job.promise = queue.then(work, work);
    queue = job.promise.catch(() => {});
    void job.promise
      .finally(() => {
        if (jobs.get(hash) === job) jobs.delete(hash);
      })
      .catch(() => {});
    jobs.set(hash, job);
    return job;
  };

  return {
    ready,
    peek: (hash) => cache.get(hash) ?? null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    analyze(s, ref, o = {}) {
      const hash = analysisHash(ref);
      const hit = cache.get(hash);
      if (hit) return Promise.resolve(hit);
      if (o.signal?.aborted) return Promise.reject(abortError());
      const running = jobs.get(hash);
      const job = running && !running.controller.signal.aborted ? running : start(s, ref, hash);
      job.waiting++;
      const listener = o.onProgress;
      if (listener) job.listeners.add(listener);
      return new Promise<TrackAnalysis>((resolve, reject) => {
        let settled = false;
        const leave = () => {
          if (settled) return false;
          settled = true;
          if (listener) job.listeners.delete(listener);
          o.signal?.removeEventListener('abort', onAbort);
          job.waiting--;
          return true;
        };
        const onAbort = () => {
          if (!leave()) return;
          if (job.waiting === 0) job.controller.abort();
          reject(abortError());
        };
        o.signal?.addEventListener('abort', onAbort);
        job.promise.then(
          (a) => leave() && resolve(a),
          (e: unknown) => leave() && reject(e),
        );
      });
    },
  };
}
