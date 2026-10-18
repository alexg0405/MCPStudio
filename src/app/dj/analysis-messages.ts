import type { TrackAnalysis } from '@core/dj/types';
import type { StreamInfo } from './analysis-stream';

/** What the main thread sends the analysis Worker for a song read in pieces (a whole-file job has no `kind`). */
export type StreamRequest =
  | { kind: 'stream-start'; id: number; info: StreamInfo }
  | { kind: 'stream-region'; id: number }
  /** Audio is transferred in; the Worker answers each scan or chunk with an `ack`. */
  | { kind: 'stream-scan'; id: number; l: Float32Array; r: Float32Array | null }
  | { kind: 'stream-chunk'; id: number; l: Float32Array; r: Float32Array | null }
  | { kind: 'stream-end'; id: number };

/** What the analysis worker answers: progress, an acknowledgement, the finished analysis, or an error. */
export type WorkerReply =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'ack' }
  | { id: number; type: 'done'; analysis: TrackAnalysis }
  | { id: number; type: 'error'; message: string };
