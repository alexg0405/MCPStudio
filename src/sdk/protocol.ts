/**
 * Message protocol between a WorkletPort (main thread) and the SDK-owned processor (audio thread).
 * Shared by both threads: no DOM or AudioWorklet globals here.
 *
 * Note events travel packed in a Float64Array, EV_STRIDE numbers per event:
 *   [type, frame, noteId, key, velocity, pan, fine]
 * `frame` is an absolute context frame (Math.round(time * sampleRate)). For a noteOff, `velocity`
 * is the release velocity. For a control change, `key` is the controller and `velocity` the value.
 */

/** Numbers per packed event. */
export const EV_STRIDE = 7;
/** Event type: a note starts (key, velocity, pan and fine pitch are set). */
export const EV_NOTE_ON = 1;
/** Event type: a note ends (velocity is the release velocity). */
export const EV_NOTE_OFF = 2;
/** Event type: release everything (queued later events are dropped). */
export const EV_ALL_OFF = 3;
/** Event type: silence everything at once. */
export const EV_ALL_OFF_HARD = 4;
/** Control change: key = controller number, velocity = value 0–1. */
export const EV_CC = 5;
/** Reserved for per-note pitch events. */
export const EV_PITCH = 6;
/**
 * The song's transport from `frame` on: [EV_TRANSPORT, frame, beat, playing, bpm, replan, 0].
 * `beat` (quarter notes, in the float64 slot) is the position at `frame`; it advances at `bpm` while
 * `playing` (1) and holds while stopped (0). A `replan` (1) anchor drops the anchors queued at or
 * after its frame: the transport re-planned (seek, edit, stop) and they no longer hold.
 */
export const EV_TRANSPORT = 7;
/**
 * A param that isn't an AudioParam (enums, on/off switches, params with `automatable: false`):
 * [EV_PARAM, frame, 0, index, value, 0, 0]. `index` is its position in `messageParamNames(specs)`,
 * `value` the encoded value (enum index, 0/1). AudioParams cost the browser time every block even
 * when nothing moves them, so only the params automation can drive are AudioParams.
 */
export const EV_PARAM = 8;

/**
 * Every kernel registers a second processor, `liteName(id)`, whose params all arrive as EV_PARAM
 * events (floats glide inside the runner like setTargetAtTime would): no AudioParams but the pitch.
 * Chrome spends about half a microsecond per AudioParam on every render block, used or not, so an
 * instance nothing automates (the usual case) runs as the lite processor, and is replaced by the
 * full one when automation first targets one of its params.
 */
export const liteName = (id: string): string => `${id}~lite`;

/** Name of the a-rate AudioParam (cents) that carries an instrument's channel pitch. */
export const PITCH_PARAM = '__pitch';

/** A message from the main thread to the processor. */
export type ToProcessor =
  | { t: 'ev'; data: Float64Array }
  | { t: 'sync'; id: number }
  | { t: 'state'; state: unknown }
  | { t: 'sample'; slot: string; channels: Float32Array[] | null; sampleRate: number }
  | { t: 'user'; msg: unknown }
  | { t: 'reset' }
  | { t: 'dispose' };

/** A message from the processor to the main thread. */
export type FromProcessor =
  | { t: 'ready' }
  | { t: 'sync'; id: number }
  | { t: 'fault'; error: string }
  | { t: 'nan' }
  | { t: 'user'; msg: unknown };

/** What the host passes a processor when it creates it (`processorOptions`). */
export interface ProcessorInit {
  kind: 'instrument' | 'effect';
  state: unknown;
  /** Seed for the kernel's deterministic random generator. */
  seed: number;
  /** Starting (encoded) values of the params that arrive as EV_PARAM events. */
  params?: Record<string, number>;
}
