/**
 * Message protocol between a WorkletPort (main thread) and the SDK-owned processor (audio thread).
 * Shared by both threads: no DOM or AudioWorklet globals here.
 *
 * Note events travel packed in a Float64Array, EV_STRIDE numbers per event:
 *   [type, frame, noteId, key, velocity, pan, fine]
 * `frame` is an absolute context frame (Math.round(time * sampleRate)). For a noteOff, `velocity`
 * is the release velocity. For a control change, `key` is the controller and `velocity` the value.
 */

export const EV_STRIDE = 7;
export const EV_NOTE_ON = 1;
export const EV_NOTE_OFF = 2;
export const EV_ALL_OFF = 3;
export const EV_ALL_OFF_HARD = 4;
/** Control change: key = controller number, velocity = value 0–1. */
export const EV_CC = 5;
/** Reserved for per-note pitch events. */
export const EV_PITCH = 6;

/** Name of the a-rate AudioParam (cents) that carries an instrument's channel pitch. */
export const PITCH_PARAM = '__pitch';

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
