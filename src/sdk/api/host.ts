/** What the host gives a plugin instance: params, state, transport, samples, the worklet and the editor tap. */
import type { ParamSpec, ParamSpecs, ValueOf } from '../params';
import type { NoteOff, NoteOn } from './notes';

/** Anything JSON can hold: what plugin state is made of, since projects are saved as JSON. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One smoothed control signal that can feed many AudioParams (e.g. a cutoff for every voice). */
export interface ParamSignal {
  /** Adds the signal to `target` (set the target's own value to 0). Returns a disconnect function. */
  connect(target: AudioParam): () => void;
  /** The underlying source node, to route the signal through your own nodes (e.g. a scaling GainNode). */
  readonly node: AudioNode;
}

/** One param as the host gives it to the plugin: its current value, automation-aware reads and ways to drive AudioParams. */
export interface ParamHandle<S extends ParamSpec = ParamSpec> {
  readonly spec: S;
  /** The current value (host-owned; changes when the user turns a knob, undoes, loads a preset…). */
  readonly value: ValueOf<S>;
  /**
   * The value in effect at an AudioContext time, automation included. Read params you use once per
   * note (envelope times, wave shapes) with `valueAt(e.time)` in noteOn: notes are scheduled ahead of
   * time, so `value` is "now", not when the note plays.
   */
  valueAt(time: number): ValueOf<S>;
  /** Drives an AudioParam with this param (smoothed). `map` converts units, e.g. dbToGain. */
  bind(target: AudioParam, map?: (v: number) => number): () => void;
  /** A shared smoothed signal for fan-out to voices. */
  signal(map?: (v: number) => number): ParamSignal;
  /** Called on every change with the new value and the AudioContext time it applies at. */
  onChange(cb: (value: ValueOf<S>, time: number) => void): () => void;
}

/** A handle for every param the plugin declares, by param id. */
export type ParamHandles<P extends ParamSpecs> = { readonly [K in keyof P]: ParamHandle<P[K]> };

/** The plugin's named sample slots (`sampleSlots` in the definition): reading, loading and listening for changes. */
export interface SampleSlots {
  /** The decoded sample in a slot, or null (empty or still loading). */
  get(slot: string): AudioBuffer | null;
  /** Resolves once the slot's sample is decoded (null when empty). */
  load(slot: string): Promise<AudioBuffer | null>;
  /** Called when the slot's sample changes. */
  onChange(slot: string, cb: (buffer: AudioBuffer | null) => void): () => void;
  /** Display name of the sample in a slot. */
  name(slot: string): string | null;
  /**
   * Length in seconds of the sample in a slot at its own speed, known without decoding it (from the file's header,
   * or recorded when it was imported), or null (empty, or not known yet). For things that must know how long a sample
   * can sound before it has loaded, above all `tailTime`: the export probe reads it before any audio is decoded.
   */
  durationSec(slot: string): number | null;
  /**
   * True when the slot holds an audio file that isn't decoded yet (built-in sounds are made on the spot and never
   * need this). An instrument in an offline render can wait for `load()` in `create()` so its first note isn't lost.
   * Optional: older hosts don't have it.
   */
  needsDecode?(slot: string): boolean;
}

/** The song's tempo, for plugins that schedule audio themselves (delays, arpeggios). */
export interface TransportInfo {
  /** The tempo now (it can change during the song with tempo automation). */
  readonly bpm: number;
  readonly ppq: number;
  /** The tempo in effect at an AudioContext time (scheduled audio uses this, not `bpm`). */
  tempoAt(time: number): number;
  /** Called when the tempo changes, with the AudioContext time the new tempo starts at. */
  onTempo(cb: (bpm: number, time: number) => void): () => void;
}

/** What an instrument knows about the channel it plays on (`host.channel`). */
export interface ChannelInfo {
  /** The channel's root key: step-sequencer notes use it and samplers play original pitch there. */
  readonly rootKey: number;
  onRootKeyChange(cb: (rootKey: number) => void): () => void;
  /**
   * The channel's pitch in cents (its pitch knob, automation and MIDI pitch bend), as a signal:
   * connect it to every voice's `detune` (leave the detune's own value for the note's tuning).
   */
  readonly pitch: ParamSignal;
  /** The channel's pitch in cents at an AudioContext time (e.g. to know how long a sample plays). */
  pitchAt(time: number): number;
  /**
   * The lowest key of any unmuted note this channel plays in the project's patterns (null: none). A sampler plays
   * lower keys slower, so this bounds how long its sample can sound: use it for `tailTime`. Read it when needed
   * (it follows edits).
   */
  readonly lowestKey: number | null;
}

/** A note of an instrument channel as an effect hears it through `host.notes`. */
export interface FeedNote {
  /** 'on' and 'off' pair by `noteId`; 'allOff' (stop, seek) releases everything. */
  readonly kind: 'on' | 'off' | 'allOff';
  /** AudioContext time in seconds, already shifted like the effect's own audio (delay compensation). */
  readonly time: number;
  readonly noteId: number;
  /** MIDI key 0–127. */
  readonly key: number;
  /** 0–1 (a note off: the release velocity). */
  readonly velocity: number;
}

/**
 * The notes instrument channels play, for effects that follow a melody (a pitch corrector pulling a voice
 * to a guide line, a vocoder keyed by a synth). Position 1 is the first instrument channel in the channel rack,
 * 2 the second, and so on (audio and automation channels are not counted); the channel is looked up when
 * a note arrives, so reordering the rack is followed.
 */
export interface NoteFeed {
  /** Calls `fn` for every note the instrument channel at `position` plays (the song, previews, live keys), until the returned function is called. */
  listen(position: number, fn: (e: FeedNote) => void): () => void;
  /** The name of the instrument channel at a position, or null when there is none. */
  channelName(position: number): string | null;
}

/** Options for `host.worklet()`. */
export interface WorkletOptions {
  /** Processor name registered with registerKernel(); defaults to the plugin id. */
  name?: string;
  /** 0 for instruments (default), 1 for effects, 2 for effects with a sidechain (input 1). */
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
  /** A MIDI control change for the kernel (kernel.controlChange), value 0–1. */
  controlChange(cc: number, value: number, time: number): void;
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

/** Options for `host.tap()`. */
export interface TapOptions {
  /** FFT size of the editor's spectrum and length of its waveforms (a power of two, 32–32768; default 4096). */
  fftSize?: number;
  /** How much the spectrum is smoothed over time, 0–1 (default 0.75). */
  smoothing?: number;
}

/** A plugin's side of its tap (`host.tap()`): readings for the editor. */
export interface PluginTap {
  /**
   * Sets named readings the editor shows (gain reduction, loudness, a detected pitch): it reads the
   * latest with `tap.reading(name)`. Cheap; call it whenever values change (≤ 60 times a second).
   */
  publish(readings: Readonly<Record<string, number>>): void;
}

/**
 * Live audio and readings of a running plugin instance, for its editor (`PluginUIProps.tap`).
 * Read it on the frame loop (`useFrame` from '@agstudio/sdk/ui') and draw on a canvas: it never
 * causes React renders. It works whenever the editor is open; `active` is false while the instance
 * loads, is missing, or doesn't tap anything (and in exports, which have no editor).
 */
export interface AudioTap {
  /** A running instance is tapped right now. */
  readonly active: boolean;
  /** Sample rate of the tapped audio (0 while inactive). */
  readonly sampleRate: number;
  /** FFT size: `spectrum()` fills fftSize / 2 bins (bin k is at k · sampleRate / fftSize Hz). */
  readonly fftSize: number;
  /**
   * The magnitude spectrum of the tapped audio (left and right mixed) in dBFS: a full-scale sine
   * reads about 0 dB in its bin. Fills up to `out.length` bins; false (and `out` untouched) while
   * inactive.
   */
  spectrum(out: Float32Array<ArrayBuffer>): boolean;
  /** The last `out.length` frames (up to fftSize) of one channel: 0 = left, 1 = right. */
  waveform(out: Float32Array<ArrayBuffer>, channel?: 0 | 1): boolean;
  /** The latest value the plugin published under `name` (undefined until it does). */
  reading(name: string): number | undefined;
}

/** Everything the host gives a plugin instance in `create(host)`: its params, state, the transport, samples and the AudioContext. */
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
  /**
   * Effects that declare `sidechain: true`: the mixer track chosen as the slot's sidechain source
   * (after its effects, before its mute, pan and fader; aligned by delay compensation), or the
   * effect's own input when none is chosen. null otherwise.
   */
  readonly sidechain: AudioNode | null;
  /**
   * Effects that declare `notes: { param }`: the notes of the instrument channel the param names (see `NoteFeed`).
   * Absent or null otherwise (and in hosts that don't feed notes).
   */
  readonly notes?: NoteFeed | null;
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
  /**
   * Lets the plugin's editor see `node`'s audio (`PluginUIProps.tap`: spectrum and waveforms) and
   * the readings you publish. Call it once in create(), usually with your output node. Cheap: the
   * host listens with AnalyserNodes and only analyses while the editor reads. Hosts without an
   * editor (exports) return a tap that ignores everything. Worklet plugins can pass `tap: true` to
   * defineWorkletEffect/defineWorkletInstrument instead.
   */
  tap?(node: AudioNode, options?: TapOptions): PluginTap;
}
