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

/**
 * The song's transport as a kernel sees it, for tempo-synced LFOs, gates and delays. Updated by the
 * SDK at the exact frame things change (play, stop, a jump, a loop wrap, a tempo change).
 */
export interface KernelTransport {
  /** True while the song plays. */
  readonly playing: boolean;
  /** Tempo in BPM (the song's tempo while stopped too). */
  readonly bpm: number;
  /** Song position in beats (quarter notes) at frame `i` of the current block; it holds while stopped. */
  beatAt(i: number): number;
}

const STOPPED: KernelTransport = { playing: false, bpm: 120, beatAt: () => 0 };

abstract class KernelBase {
  constructor(protected readonly host: KernelHost) {}

  /** The song's transport (the SDK replaces this with the live one before the kernel runs). */
  transport: KernelTransport = STOPPED;
  /** The transport played, stopped, jumped, wrapped or changed tempo (e.g. to restart LFO phases). */
  transportChanged?(): void;

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
  /**
   * The channel's pitch in cents for the current block (its pitch knob, automation and MIDI pitch
   * bend): length 1 when constant, else one value per frame (read it with `at`).
   */
  pitch: Float32Array = new Float32Array(1);

  /**
   * Set true for an instrument that starts sounding by itself when the song starts or jumps (a
   * sequencer, an arpeggiator), without a note. Otherwise a sleeping instrument stays asleep through
   * transport changes and only a note or a controller wakes it.
   */
  wakeOnTransport = false;

  /** `fine` is the note's fine pitch in cents. */
  abstract noteOn(key: number, velocity: number, noteId: number, pan: number, fine: number): void;
  /** `release` is the release velocity 0–1. */
  abstract noteOff(noteId: number, key: number, release: number): void;
  /** Release everything (or silence it immediately when `hard`). */
  allNotesOff(_hard: boolean): void {}
  /** A MIDI control change (mod wheel = 1, …), value 0–1. */
  controlChange?(cc: number, value: number): void;
  /**
   * ADD audio into out[channel][from..to). Outputs start zeroed each block; the SDK splits blocks at
   * note events so `from`/`to` mark the frames between events.
   */
  abstract render(out: Float32Array[], from: number, to: number, params: ParamBlock<P>): void;
}

export abstract class EffectKernel<P extends ParamSpecs = ParamSpecs> extends KernelBase {
  /**
   * Effects defined with `notes: { param }` hear the notes of an instrument channel through these (optional)
   * methods. They are called at the start of the render block the event falls in (a block is 128 frames, under
   * 3 ms), before `process()`; `velocity` is 0–1, a note off's the release velocity.
   */
  noteOn?(key: number, velocity: number, noteId: number): void;
  noteOff?(noteId: number, key: number, release: number): void;
  /** Everything held is released (the channel changed, the song stopped or jumped). */
  allNotesOff?(hard: boolean): void;

  /**
   * Writes `n` frames from `input` into `output` (input always has as many channels as output).
   * Effects defined with `sidechain: true` also get the sidechain signal (the chosen track, or the
   * effect's own input when none is chosen; zeros while the source plays nothing), with as many
   * channels as `output`.
   */
  abstract process(
    input: Float32Array[],
    output: Float32Array[],
    n: number,
    params: ParamBlock<P>,
    sidechain?: Float32Array[],
  ): void;
}

export { PITCH_PARAM } from '../protocol';

export type KernelClass<P extends ParamSpecs = ParamSpecs> = new (
  host: KernelHost,
) => InstrumentKernel<P> | EffectKernel<P>;
