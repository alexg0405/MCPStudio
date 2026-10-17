/**
 * Track analyses by content hash: computed in a Worker the first time a song is looked at, stored so
 * it is never computed twice (survives reloads), and shared by the library, the auto-mix and the decks.
 * (The analysis itself lives in core/dj; this is the cache and the entry point the UI and actions call.)
 */
import { MAX_WHOLE_DECODE_SEC } from '@core/dj/long';
import type { SampleRef } from '@core/model/types';
import { ANALYSIS_VERSION, type TrackAnalysis } from '@core/dj/types';
import { decodeAudio } from '@engine/decode';
import { idbDel, idbGet, idbKeys, idbSet, isIdbAvailable } from '@platform/idb';
import { opfsSampleProvider } from '../persistence/project-io';
import type { Services } from '../services';
import { openLongSource, type StreamSource } from './analysis-stream-run';
import { abortError, inlineRunner, inlineStreamRunner, workerHost, workerRunner, workerStreamRunner, type AnalysisRunner, type StreamRunner } from './analysis-workers';

export { inlineRunner, inlineStreamRunner };
export type { AnalysisRunner, StreamRunner };

export interface AnalysisProgress {
  hash: string;
  /** 0–1 */
  fraction: number;
}

/** 'now' (a deck is waiting for it) goes ahead of every queued 'background' job (the library's); it never interrupts the running one. */
export type AnalysisPriority = 'now' | 'background';

export interface TrackAnalyzer {
  /** The cached analysis, or null (not analyzed yet). */
  peek(hash: string): TrackAnalysis | null;
  /**
   * The analysis: cached, or computed now (the file is decoded and analyzed off the main thread). Queued behind the running
   * song; `priority` defaults to 'background'.
   */
  analyze(
    s: Services,
    ref: SampleRef,
    opts?: { signal?: AbortSignal; onProgress?(p: AnalysisProgress): void; priority?: AnalysisPriority },
  ): Promise<TrackAnalysis>;
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

interface Job {
  hash: string;
  /** Moves from 'background' to 'now' when a caller asks for the song urgently (never back). */
  priority: AnalysisPriority;
  /** queued: waiting its turn in a queue; running: being analyzed; done: settled. */
  state: 'queued' | 'running' | 'done';
  controller: AbortController;
  /** How many callers are still waiting for this job. */
  waiting: number;
  listeners: Set<(p: AnalysisProgress) => void>;
  promise: Promise<TrackAnalysis>;
  resolve(a: TrackAnalysis): void;
  reject(e: unknown): void;
  /** The job's work: the cache, or decode and analyze. */
  run(): Promise<TrackAnalysis>;
}

export interface TrackAnalyzerOptions {
  storage?: AnalysisStorage;
  decode?: AnalysisDecoder;
  run?: AnalysisRunner;
  /**
   * The song's file as a source read by parts when it is too long to decode whole, else null (then `decode` and `run` are
   * used). The default reads WAV and MP3 files from the sample store that are longer than `LONG_SONG_SEC`.
   */
  openStream?: (s: Services, ref: SampleRef) => Promise<StreamSource | null>;
  runStream?: StreamRunner;
}

/**
 * The analyzer: one song at a time, from a queue. A 'now' job goes ahead of every queued 'background' job (it never
 * interrupts the running one); within a priority, jobs run first in first out. Callers asking for the same song share its
 * job, and a 'now' caller moves a queued background job up. A job is cancelled when every caller waiting for it has
 * aborted: a queued one leaves the queue, a running one is stopped.
 */
export function createTrackAnalyzer(opts: TrackAnalyzerOptions = {}): TrackAnalyzer & { ready: Promise<void> } {
  const storage = opts.storage ?? idbAnalysisStorage;
  const decode = opts.decode ?? defaultDecoder;
  const host = workerHost();
  const run = opts.run ?? workerRunner(host);
  const runStream = opts.runStream ?? workerStreamRunner(host);
  const openStream = opts.openStream ?? ((_s: Services, ref: SampleRef) => openLongSource(ref));
  const cache = new Map<string, TrackAnalysis>();
  /** The job of each song that is queued or running. */
  const jobs = new Map<string, Job>();
  /** Queued jobs by priority, in arrival order. */
  const queues: Record<AnalysisPriority, Job[]> = { now: [], background: [] };
  let running: Job | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

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

  /** The work of one job: the cache, or the file decoded and analyzed (by parts when it is too long to decode whole). */
  const analyzeSong = async (job: Job, s: Services, ref: SampleRef): Promise<TrackAnalysis> => {
    const { hash, controller } = job;
    const progress = (fraction: number) => job.listeners.forEach((fn) => fn({ hash, fraction }));
    const finished = (analysis: TrackAnalysis): TrackAnalysis => {
      cache.set(hash, analysis);
      void storage.save(analysis).catch((e: unknown) => console.warn('[agstudio] saving a track analysis failed', e));
      progress(1);
      emit();
      return analysis;
    };
    await ready;
    const hit = cache.get(hash);
    if (hit) return hit;
    controller.signal.throwIfAborted();
    progress(0);
    // A song too long to decode whole is read and analyzed in pieces: its audio is never in memory at once.
    const stream = await openStream(s, ref).catch(() => null);
    if (stream) {
      try {
        return finished(await runStream(hash, stream, progress, controller.signal));
      } finally {
        stream.dispose();
      }
    }
    if (ref.durationSec !== undefined && ref.durationSec > MAX_WHOLE_DECODE_SEC)
      throw new Error(`“${ref.name}” is longer than ${MAX_WHOLE_DECODE_SEC / 60} minutes and its format can’t be analyzed in parts: use an MP3 or WAV of it.`);
    const audio = await decode(s, ref);
    if (!audio || (audio.channels[0]?.length ?? 0) === 0) throw new Error(`“${ref.name}” couldn’t be decoded for analysis.`);
    controller.signal.throwIfAborted();
    progress(0.05);
    return finished(await run({ hash, ...audio }, (f) => progress(0.05 + 0.95 * f), controller.signal));
  };

  const newJob = (s: Services, ref: SampleRef, hash: string, priority: AnalysisPriority): Job => {
    let resolve!: (a: TrackAnalysis) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<TrackAnalysis>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers handle their own failures; a cancelled job with nobody left must not report one.
    promise.catch(() => {});
    const job: Job = {
      hash,
      priority,
      state: 'queued',
      controller: new AbortController(),
      waiting: 0,
      listeners: new Set(),
      promise,
      resolve,
      reject,
      run: () => analyzeSong(job, s, ref),
    };
    return job;
  };

  const removeQueued = (job: Job): void => {
    const q = queues[job.priority];
    const i = q.indexOf(job);
    if (i >= 0) q.splice(i, 1);
  };

  const finish = (job: Job): void => {
    job.state = 'done';
    if (jobs.get(job.hash) === job) jobs.delete(job.hash);
    running = null;
    pump();
  };

  /** Starts the next job when nothing is running: a 'now' job if there is one, else the oldest background job. */
  const pump = (): void => {
    if (running) return;
    const job = queues.now.shift() ?? queues.background.shift();
    if (!job) return;
    running = job;
    job.state = 'running';
    job.run().then(
      (a) => {
        job.resolve(a);
        finish(job);
      },
      (e: unknown) => {
        job.reject(e);
        finish(job);
      },
    );
  };

  /** Moves a queued background job to the back of the 'now' queue. */
  const promote = (job: Job): void => {
    if (job.state !== 'queued' || job.priority === 'now') return;
    removeQueued(job);
    job.priority = 'now';
    queues.now.push(job);
  };

  /** Stops a job nobody waits for any more: a queued one leaves its queue, a running one is stopped by its signal. */
  const cancel = (job: Job): void => {
    job.controller.abort();
    if (job.state !== 'queued') return;
    removeQueued(job);
    job.state = 'done';
    if (jobs.get(job.hash) === job) jobs.delete(job.hash);
    job.reject(abortError());
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
      const priority = o.priority ?? 'background';
      const existing = jobs.get(hash);
      let job: Job;
      if (existing && !existing.controller.signal.aborted) job = existing;
      else {
        // A job being stopped is replaced: its work ends on its own.
        job = newJob(s, ref, hash, priority);
        jobs.set(hash, job);
        queues[priority].push(job);
      }
      if (priority === 'now') promote(job);
      job.waiting++;
      const listener = o.onProgress;
      if (listener) job.listeners.add(listener);
      const result = new Promise<TrackAnalysis>((resolve, reject) => {
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
          if (job.waiting === 0) cancel(job);
          reject(abortError());
        };
        o.signal?.addEventListener('abort', onAbort);
        job.promise.then(
          (a) => leave() && resolve(a),
          (e: unknown) => leave() && reject(e),
        );
      });
      pump();
      return result;
    },
  };
}
