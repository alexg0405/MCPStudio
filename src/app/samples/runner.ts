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
      if (read.kind === 'audio') return analyzeSample(read.channels, read.sampleRate, { path, durationSec: read.durationSec });
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

/** `size` Workers taking files in order. */
export function workerPoolRunner(size: number, decode: DecodeForAnalysis = browserDecode): AnalysisRunner {
  if (typeof Worker === 'undefined') return inlineRunner(decode);
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let seq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const stopAll = () => {
    for (const s of slots.splice(0)) {
      s.worker.terminate();
      s.job?.resolve(null);
    }
  };

  const spawn = (): Slot | null => {
    try {
      const slot: Slot = { worker: new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }), job: null, reply: null };
      slot.worker.onmessage = (e: MessageEvent<WorkerReply>) => slot.reply?.(e.data);
      slot.worker.onerror = () => {
        // The job it was running is lost (null: not analyzed); a new Worker takes the next one.
        slot.worker.terminate();
        const i = slots.indexOf(slot);
        if (i >= 0) slots.splice(i, 1);
        slot.job?.resolve(null);
        pump();
      };
      return slot;
    } catch {
      return null;
    }
  };

  const finish = (slot: Slot, result: SampleAnalysis | null) => {
    const job = slot.job;
    slot.job = null;
    slot.reply = null;
    job?.resolve(result);
    pump();
  };

  const start = (slot: Slot, job: Job) => {
    slot.job = job;
    const id = ++seq;
    slot.reply = (r) => {
      if (r.id !== id) return;
      if (r.ok) return finish(slot, r.analysis);
      if (r.reason !== 'needs-decode') return finish(slot, null);
      // The browser decodes it (off this thread); the Worker analyzes the audio.
      void job.file
        .arrayBuffer()
        .then((bytes) => decode(bytes))
        .then((audio) => {
          if (!audio) return finish(slot, null);
          const next = ++seq;
          slot.reply = (r2) => {
            if (r2.id !== next) return;
            finish(slot, r2.ok ? r2.analysis : null);
          };
          const msg: WorkerRequest = { id: next, kind: 'audio', channels: audio.channels, sampleRate: audio.sampleRate, durationSec: audio.durationSec, path: job.path };
          slot.worker.postMessage(msg, audio.channels.map((c) => c.buffer as ArrayBuffer));
        })
        .catch(() => finish(slot, null));
    };
    const msg: WorkerRequest = { id, kind: 'file', file: job.file, path: job.path };
    slot.worker.postMessage(msg);
  };

  function pump(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    while (queue.length > 0) {
      let slot = slots.find((s) => s.job === null);
      if (!slot && slots.length < size) {
        const made = spawn();
        if (!made) {
          // No Worker could be made: this thread does the rest.
          const inline = inlineRunner(decode);
          for (const j of queue.splice(0)) void inline.run(j.file, j.path).then(j.resolve, () => j.resolve(null));
          return;
        }
        slots.push(made);
        slot = made;
      }
      if (!slot) return;
      start(slot, queue.shift() as Job);
    }
    if (slots.every((s) => s.job === null) && slots.length > 0) idleTimer = setTimeout(stopAll, IDLE_MS);
  }

  return {
    run(file, path) {
      return new Promise((resolve) => {
        queue.push({ file, path, resolve });
        pump();
      });
    },
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      for (const j of queue.splice(0)) j.resolve(null);
      stopAll();
    },
  };
}

/** Workers for the analysis: most of the cores but never all of them, at least one. */
export function analysisWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, cores - 2));
}
