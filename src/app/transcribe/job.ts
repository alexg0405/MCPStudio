import { listen, suggestMode, type Heard, type ModeSuggestion, type TranscribeMode } from '@core/audio/transcribe';

/** One piece of work for "Convert to MIDI" that runs off the main thread (listening to a recording, or looking at it for a mode). */
export type TranscribeJob =
  | { kind: 'listen'; mode: TranscribeMode; mono: Float32Array; sampleRate: number; sensitivity: number; startSec: number }
  | { kind: 'suggest'; mono: Float32Array; sampleRate: number };

/** What a job answers with. */
export type TranscribeReply = { id: number; ok: true; heard?: Heard; suggestion?: ModeSuggestion } | { id: number; ok: false; error: string };

/** Runs a job on whatever thread this is: the Worker's own, or the caller's (Node tests, or where a Worker cannot start). */
export function runTranscribeJob(job: TranscribeJob): { heard?: Heard; suggestion?: ModeSuggestion } {
  if (job.kind === 'suggest') return { suggestion: suggestMode(job.mono, job.sampleRate) };
  return { heard: listen(job.mode, job.mono, job.sampleRate, { sensitivity: job.sensitivity, startSec: job.startSec }) };
}
