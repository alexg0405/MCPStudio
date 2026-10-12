/**
 * Kernels are where custom per-sample DSP lives. They are plain classes (no AudioWorklet globals),
 * so they can be unit-tested in Node. The SDK's processor owns the AudioWorkletProcessor, splits
 * blocks at note events, guards against NaN and exceptions, and calls these methods.
 */
import type { ParamSpecs } from '../params';

/** Per-block param values: length 1 when constant for the block, else one value per frame. */
export type ParamBlock<P extends ParamSpecs = ParamSpecs> = { readonly [K in keyof P]: Float32Array };

/** Value of a param at frame `i` of the current block. */
export function at(values: Float32Array, i: number): number {
  return (values.length > 1 ? values[i] : values[0]) as number;
}

export interface KernelHost {
  readonly sampleRate: number;
  /** Plugin state at construction (later changes arrive via setState). */
  readonly state: unknown;
  /** Sends a message to the plugin's main-thread side (WorkletPort.onMessage). Keep it rare (≤ 30 Hz). */
  post(msg: unknown): void;
  /** Deterministic random number in [0, 1). Use instead of Math.random. */
  rand(): number;
}

abstract class KernelBase {
  constructor(protected readonly host: KernelHost) {}

  get sampleRate(): number {
    return this.host.sampleRate;
  }

  /** Plugin state changed on the main thread (host.updateState / undo / preset). */
  setState?(state: unknown): void;
  /** A message from WorkletPort.send(). */
  onMessage?(msg: unknown): void;
  /** A sample slot's audio (copied to the audio thread), or null when emptied. */
  onSample?(slot: string, channels: Float32Array[] | null, sampleRate: number): void;
  /** Clear internal buffers (panic, or after a NaN was caught). */
  reset?(): void;
}

export abstract class InstrumentKernel<P extends ParamSpecs = ParamSpecs> extends KernelBase {
  abstract noteOn(key: number, velocity: number, noteId: number, pan: number): void;
  abstract noteOff(noteId: number, key: number): void;
  /** Release everything (or silence it immediately when `hard`). */
  allNotesOff(_hard: boolean): void {}
  /**
   * ADD audio into out[channel][from..to). Outputs start zeroed each block; the SDK splits blocks at
   * note events so `from`/`to` mark the frames between events.
   */
  abstract render(out: Float32Array[], from: number, to: number, params: ParamBlock<P>): void;
}

export abstract class EffectKernel<P extends ParamSpecs = ParamSpecs> extends KernelBase {
  /** Writes `n` frames from `input` into `output` (input always has as many channels as output). */
  abstract process(input: Float32Array[], output: Float32Array[], n: number, params: ParamBlock<P>): void;
}

export type KernelClass<P extends ParamSpecs = ParamSpecs> = new (
  host: KernelHost,
) => InstrumentKernel<P> | EffectKernel<P>;
