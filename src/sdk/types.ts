/**
 * AGstudio plugin SDK: the contract between plugins (instruments and effects) and the host.
 * Plugins import only from '@agstudio/sdk' (and '/params', '/worklet', '/dsp', '/ui').
 */
import type { ParamSpec, ParamSpecs, ParamValue, ValueOf } from './params';

/** A React function component (kept structural so the core SDK has no React dependency). */
export type PluginUIComponent<Props> = (props: Props) => unknown;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface NoteOn {
  /** AudioContext time in seconds. May be slightly in the past for live input; start ASAP then. */
  time: number;
  /** Unique per note; pairs the noteOff with its noteOn. */
  noteId: number;
  /** MIDI key 0–127 (60 = FL's C5). */
  key: number;
  /** 0–1. */
  velocity: number;
  /** -1 … 1, from the note's pan. */
  pan?: number;
  /** Seconds into the sound to start at (set for audio clips that start mid-way). */
  offset?: number;
}

export interface NoteOff {
  /** If this is at or before the note's start, the note is cancelled (never sounds). */
  time: number;
  noteId: number;
  key: number;
}

/** One smoothed control signal that can feed many AudioParams (e.g. a cutoff for every voice). */
export interface ParamSignal {
  /** Adds the signal to `target` (set the target's own value to 0). Returns a disconnect function. */
  connect(target: AudioParam): () => void;
  /** The underlying source node, to route the signal through your own nodes (e.g. a scaling GainNode). */
  readonly node: AudioNode;
}

export interface ParamHandle<S extends ParamSpec = ParamSpec> {
  readonly spec: S;
  /** The current value (host-owned; changes when the user turns a knob, undoes, loads a preset…). */
  readonly value: ValueOf<S>;
  /** Drives an AudioParam with this param (smoothed). `map` converts units, e.g. dbToGain. */
  bind(target: AudioParam, map?: (v: number) => number): () => void;
  /** A shared smoothed signal for fan-out to voices. */
  signal(map?: (v: number) => number): ParamSignal;
  /** Called on every change with the new value and the AudioContext time it applies at. */
  onChange(cb: (value: ValueOf<S>, time: number) => void): () => void;
}

export type ParamHandles<P extends ParamSpecs> = { readonly [K in keyof P]: ParamHandle<P[K]> };

export interface SampleSlots {
  /** The decoded sample in a slot, or null (empty or still loading). */
  get(slot: string): AudioBuffer | null;
  /** Resolves once the slot's sample is decoded (null when empty). */
  load(slot: string): Promise<AudioBuffer | null>;
  /** Called when the slot's sample changes. */
  onChange(slot: string, cb: (buffer: AudioBuffer | null) => void): () => void;
  /** Display name of the sample in a slot. */
  name(slot: string): string | null;
}

export interface TransportInfo {
  readonly bpm: number;
  readonly ppq: number;
  onTempo(cb: (bpm: number) => void): () => void;
}

export interface ChannelInfo {
  /** The channel's root key: step-sequencer notes use it and samplers play original pitch there. */
  readonly rootKey: number;
  onRootKeyChange(cb: (rootKey: number) => void): () => void;
}

export interface WorkletOptions {
  /** Processor name registered with registerKernel(); defaults to the plugin id. */
  name?: string;
  /** 0 for instruments (default), 1 for effects. */
  numberOfInputs?: number;
  /** Defaults to [2] (stereo). */
  outputChannelCount?: number[];
}

/** Main-thread handle to a plugin's AudioWorklet processor. */
export interface WorkletPort {
  readonly node: AudioWorkletNode;
  noteOn(e: NoteOn): void;
  noteOff(e: NoteOff): void;
  allNotesOff(time: number, hard?: boolean): void;
  setState(state: unknown): void;
  /** Copies a sample's audio to the processor (kernel.onSample). */
  sendSample(slot: string, buffer: AudioBuffer | null): void;
  /** Custom message to the kernel (kernel.onMessage). */
  send(msg: unknown, transfer?: Transferable[]): void;
  /** Clears the kernel's buffers (kernel.reset). */
  reset(): void;
  /** Messages the kernel posted with host.post(). */
  onMessage(cb: (msg: unknown) => void): () => void;
  /** Resolves once the processor has handled everything sent before this call. */
  sync(): Promise<void>;
  dispose(): void;
}

export interface PluginHost<P extends ParamSpecs = ParamSpecs, S = JsonValue | undefined> {
  /** Realtime or offline (export) context. Never create your own. */
  readonly audioContext: BaseAudioContext;
  readonly params: ParamHandles<P>;
  /** Host-owned non-param state (migrated). */
  readonly state: S;
  /** Requests a state change; it becomes an undoable edit and comes back through setState(). */
  updateState(next: S): void;
  readonly transport: TransportInfo;
  readonly samples: SampleSlots;
  /** Present for instruments on a channel. */
  readonly channel: ChannelInfo | null;
  /** True while rendering an export. */
  readonly offline: boolean;
  /** Aborted when the instance is disposed. */
  readonly signal: AbortSignal;
  /**
   * Creates an AudioWorkletNode running this plugin's `processor` module, with every param bound to
   * the node's AudioParams. Used by defineWorkletInstrument/defineWorkletEffect; call it directly to
   * mix native nodes with custom DSP.
   */
  worklet(opts?: WorkletOptions): Promise<WorkletPort>;
}

export interface InstrumentInstance<S = unknown> {
  readonly output: AudioNode;
  noteOn(e: NoteOn): void;
  noteOff(e: NoteOff): void;
  /** Releases everything sounding at `time` and drops anything scheduled at or after it. */
  allNotesOff(time: number, hard?: boolean): void;
  setState?(state: S): void;
  dispose(): void;
  /** Seconds of release tail after the last note (export padding). */
  readonly tailTime?: number;
}

export interface EffectInstance<S = unknown> {
  readonly input: AudioNode;
  readonly output: AudioNode;
  setState?(state: S): void;
  /** Clears internal buffers (delay lines, reverb tails). */
  reset?(): void;
  dispose(): void;
  readonly latency?: number;
  readonly tailTime?: number;
}

export interface PluginUIProps<P extends ParamSpecs = ParamSpecs, S = unknown> {
  specs: P;
  values: { readonly [K in keyof P]: ValueOf<P[K]> };
  state: S;
  /** Start of a continuous edit (knob drag); everything until endEdit() is one undo step. */
  beginEdit(param: keyof P & string): void;
  setParam(param: keyof P & string, value: ParamValue): void;
  endEdit(param: keyof P & string): void;
  setState(next: S): void;
}

export interface Preset<P extends ParamSpecs, S> {
  name: string;
  params?: Partial<{ [K in keyof P]: ValueOf<P[K]> }>;
  state?: S;
}

interface DefBase<P extends ParamSpecs, S> {
  /** Reverse-DNS-ish unique id, e.g. 'user.sub-bass'. Never change it once projects use it. */
  id: string;
  name: string;
  /** State/param schema version; bump it when you change params or state in a breaking way. */
  version: number;
  category?: string;
  description?: string;
  params: P;
  defaultState?: S;
  /** Named sample slots this plugin uses (lets the UI offer drop targets). */
  sampleSlots?: readonly string[];
  /** URL of the AudioWorklet module: `import processor from './x.worklet.ts?worker&url'`. */
  processor?: string;
  /** Upgrades data saved by an older `version`. */
  migrate?(old: { version: number; params: Record<string, unknown>; state: unknown }): {
    params: Record<string, unknown>;
    state: S;
  };
  /** Optional custom editor. Without it the host generates a knob panel from `params`. */
  ui?: PluginUIComponent<PluginUIProps<P, S>>;
  presets?: readonly Preset<P, S>[];
}

export interface InstrumentDef<P extends ParamSpecs = ParamSpecs, S = unknown> extends DefBase<P, S> {
  kind: 'instrument';
  create(host: PluginHost<P, S>): InstrumentInstance<S> | Promise<InstrumentInstance<S>>;
}

export interface EffectDef<P extends ParamSpecs = ParamSpecs, S = unknown> extends DefBase<P, S> {
  kind: 'effect';
  create(host: PluginHost<P, S>): EffectInstance<S> | Promise<EffectInstance<S>>;
}

// Definitions are stored heterogeneously by the host.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInstrumentDef = InstrumentDef<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEffectDef = EffectDef<any, any>;
export type PluginDef = AnyInstrumentDef | AnyEffectDef;

export function defineInstrument<const P extends ParamSpecs, S = undefined>(
  def: Omit<InstrumentDef<P, S>, 'kind'>,
): InstrumentDef<P, S> {
  return { kind: 'instrument', ...def };
}

export function defineEffect<const P extends ParamSpecs, S = undefined>(
  def: Omit<EffectDef<P, S>, 'kind'>,
): EffectDef<P, S> {
  return { kind: 'effect', ...def };
}
