/**
 * Running the sample analysis: a small pool of Workers (`analysis.worker.ts`) that read and analyze files, or the same code
 * on this thread where there are no Workers (Node tests). A file the Worker cannot decode (MP3, FLAC, OGG, M4A) is decoded
 * here by the browser, off the main thread, at 44.1 kHz, and the audio goes back to the Worker.
 */
import { analyzeSample, LOOP_ANALYSIS_SEC } from '@core/samples/analyze';
import { SAMPLE_ANALYSIS_VERSION, type SampleAnalysis } from '@core/samples/types';
import { decodeAudio } from '@engine/decode';
import type { WorkerReply, WorkerRequest } from './protocol';
import { readForAnalysis } from './read';

export interface AnalysisRunner {
  /** The analysis of one file, or null when it cannot be read as audio. */
  run(file: Blob, path: string): Promise<SampleAnalysis | null>;
  /** Stops the Workers; later runs make new ones. */
  dispose(): void;
}

/** Decodes a compressed file for the analysis (the first seconds only). */
export type DecodeForAnalysis = (bytes: ArrayBuffer) => Promise<{ channels: Float32Array[]; sampleRate: number; durationSec: number } | null>;

const DECODE_RATE = 44100;

/** The browser's own decoder (needs an OfflineAudioContext). */
export const browserDecode: DecodeForAnalysis = async (bytes) => {
  if (typeof OfflineAudioContext === 'undefined') return null;
  try {
    const buffer = await decodeAudio(new OfflineAudioContext(1, 1, DECODE_RATE), bytes);
    const frames = Math.min(buffer.length, Math.round(LOOP_ANALYSIS_SEC * buffer.sampleRate));
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice(0, frames));
    return { channels, sampleRate: buffer.sampleRate, durationSec: buffer.duration };
  } catch {
    return null;
  }
};

const longAnalysis = (durationSec: number): SampleAnalysis => ({
  v: SAMPLE_ANALYSIS_VERSION,
  kind: 'long',
  durationSec,
  category: null,
  confidence: 0,
  loudnessDb: -180,
  peakDb: -180,
  brightness: 0,
  vec: [],
});

/** The same work on this thread (tests, and a fallback where Workers are missing). */
export function inlineRunner(decode: DecodeForAnalysis = browserDecode): AnalysisRunner {
  return {
    async run(file, path) {
      const read = await readForAnalysis(file);
      if (read.kind === 'audio') return analyzeSample(read.channels, read.sampleRate, { path, durationSec: read.durationSec, ...(read.rootKey !== undefined ? { rootKey: read.rootKey } : {}) });
      if (read.kind === 'long') return longAnalysis(read.durationSec);
      if (read.kind === 'unreadable') return null;
      const audio = await decode(await file.arrayBuffer());
      return audio ? analyzeSample(audio.channels, audio.sampleRate, { path, durationSec: audio.durationSec }) : null;
    },
    dispose() {},
  };
}

interface Job {
  file: Blob;
  path: string;
  resolve(a: SampleAnalysis | null): void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  /** Called with the Worker's reply to the job it is running. */
  reply: ((r: WorkerReply) => void) | null;
}

/** Workers are stopped this long after the last job (they hold the analyzer's code and buffers). */
const IDLE_MS = 5000;

/** Up to `size` Workers taking queued files in order, made when needed and stopped when idle. */
class WorkerPool implements AnalysisRunner {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  /** The id of the next message to a Worker (a reply names the message it answers). */
  private seq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly size: number,
    private readonly decode: DecodeForAnalysis,
  ) {}

  run(file: Blob, path: string): Promise<SampleAnalysis | null> {
    return new Promise((resolve) => {
      this.queue.push({ file, path, resolve });
      this.pump();
    });
  }

  dispose(): void {
    this.clearIdleTimer();
    for (const job of this.queue.splice(0)) job.resolve(null);
    this.stopAll();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Stops every Worker; the files they were running count as not analyzed. */
  private stopAll(): void {
    for (const slot of this.slots.splice(0)) {
      slot.worker.terminate();
      slot.job?.resolve(null);
    }
  }

  /** A new Worker slot, or null where Workers cannot be made. */
  private spawn(): Slot | null {
    try {
      const slot: Slot = { worker: new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }), job: null, reply: null };
      slot.worker.onmessage = (e: MessageEvent<WorkerReply>) => slot.reply?.(e.data);
      slot.worker.onerror = () => this.lose(slot);
      return slot;
    } catch {
      return null;
    }
  }

  /** The Worker failed: the job it was running is lost (null: not analyzed) and a new Worker takes the next one. */
  private lose(slot: Slot): void {
    slot.worker.terminate();
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    slot.job?.resolve(null);
    this.pump();
  }

  /** The Worker is done with its job: hand back the result and give it the next file. */
  private finish(slot: Slot, result: SampleAnalysis | null): void {
    const job = slot.job;
    slot.job = null;
    slot.reply = null;
    job?.resolve(result);
    this.pump();
  }

  /** Sends the file to the Worker; a format only the browser can decode goes through `decodeThenAnalyze`. */
  private start(slot: Slot, job: Job): void {
    slot.job = job;
    const id = ++this.seq;
    slot.reply = (r) => {
      if (r.id !== id) return;
      if (r.ok) return this.finish(slot, r.analysis);
      if (r.reason !== 'needs-decode') return this.finish(slot, null);
      this.decodeThenAnalyze(slot, job);
    };
    const msg: WorkerRequest = { id, kind: 'file', file: job.file, path: job.path };
    slot.worker.postMessage(msg);
  }

  /** The browser decodes the file (off this thread); the Worker analyzes the audio. */
  private decodeThenAnalyze(slot: Slot, job: Job): void {
    void job.file
      .arrayBuffer()
      .then((bytes) => this.decode(bytes))
      .then((audio) => {
        if (!audio) return this.finish(slot, null);
        const next = ++this.seq;
        slot.reply = (r2) => {
          if (r2.id !== next) return;
          this.finish(slot, r2.ok ? r2.analysis : null);
        };
        const msg: WorkerRequest = { id: next, kind: 'audio', channels: audio.channels, sampleRate: audio.sampleRate, durationSec: audio.durationSec, path: job.path };
        slot.worker.postMessage(msg, audio.channels.map((c) => c.buffer as ArrayBuffer));
      })
      .catch(() => this.finish(slot, null));
  }

  /** Hands queued files to idle Workers (making Workers up to the pool size), and stops the Workers once they have all been idle a while. */
  private pump(): void {
    this.clearIdleTimer();
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => s.job === null);
      if (!slot && this.slots.length < this.size) {
        const made = this.spawn();
        if (!made) {
          this.analyzeQueueHere();
          return;
        }
        this.slots.push(made);
        slot = made;
      }
      if (!slot) return;
      this.start(slot, this.queue.shift() as Job);
    }
    if (this.slots.length > 0 && this.slots.every((s) => s.job === null)) this.idleTimer = setTimeout(() => this.stopAll(), IDLE_MS);
  }

  /** No Worker could be made: this thread does the rest. */
  private analyzeQueueHere(): void {
    const inline = inlineRunner(this.decode);
    for (const job of this.queue.splice(0)) void inline.run(job.file, job.path).then(job.resolve, () => job.resolve(null));
  }
}

/** `size` Workers taking files in order. */
export function workerPoolRunner(size: number, decode: DecodeForAnalysis = browserDecode): AnalysisRunner {
  if (typeof Worker === 'undefined') return inlineRunner(decode);
  return new WorkerPool(size, decode);
}

/** Workers for the analysis: most of the cores but never all of them, at least one. */
export function analysisWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, cores - 2));
}
