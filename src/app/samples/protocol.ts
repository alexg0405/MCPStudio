import type { SampleAnalysis } from '@core/samples/types';

/** Messages between the sample browser and its analysis Workers (`analysis.worker.ts`). */
export type WorkerRequest =
  /** A file to read and analyze in the Worker. */
  | { id: number; kind: 'file'; file: Blob; path: string }
  /** Audio the main thread decoded for a file the Worker could not (channels are transferred). */
  | { id: number; kind: 'audio'; channels: Float32Array[]; sampleRate: number; durationSec: number; path: string };

export type WorkerReply =
  | { id: number; ok: true; analysis: SampleAnalysis }
  /** The Worker cannot decode this format: the main thread decodes it and sends the audio. */
  | { id: number; ok: false; reason: 'needs-decode'; durationSec: number | null }
  | { id: number; ok: false; reason: 'unreadable' | 'error'; message?: string };
