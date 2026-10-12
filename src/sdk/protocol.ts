/**
 * Message protocol between a WorkletPort (main thread) and the SDK-owned processor (audio thread).
 * Shared by both threads: no DOM or AudioWorklet globals here.
 *
 * Note events travel packed in a Float64Array, EV_STRIDE numbers per event:
 *   [type, frame, noteId, key, velocity, pan]
 * `frame` is an absolute context frame (Math.round(time * sampleRate)).
 */

export const EV_STRIDE = 6;
export const EV_NOTE_ON = 1;
export const EV_NOTE_OFF = 2;
export const EV_ALL_OFF = 3;
export const EV_ALL_OFF_HARD = 4;

export type ToProcessor =
  | { t: 'ev'; data: Float64Array }
  | { t: 'sync'; id: number }
  | { t: 'state'; state: unknown }
  | { t: 'sample'; slot: string; channels: Float32Array[] | null; sampleRate: number }
  | { t: 'user'; msg: unknown }
  | { t: 'reset' }
  | { t: 'dispose' };

export type FromProcessor =
  | { t: 'ready' }
  | { t: 'sync'; id: number }
  | { t: 'fault'; error: string }
  | { t: 'nan' }
  | { t: 'user'; msg: unknown };

export interface ProcessorInit {
  kind: 'instrument' | 'effect';
  state: unknown;
  /** Seed for the kernel's deterministic random generator. */
  seed: number;
}
