/**
 * The engine's public surface. The UI may import types from here (and only here); it reaches the
 * engine instance through app services.
 */
import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, PatternId, PluginOwner, SampleRef, Tick } from '@core/model/types';
import type { JsonValue, PluginDef } from '@agstudio/sdk';
import type { Waveform } from './waveform';
import type { RecordOptions, Recording, RecordingHandle } from './recorder';

export type { Waveform, RecordOptions, Recording, RecordingHandle };

export type EngineState = 'suspended' | 'running' | 'closed' | 'interrupted';

export interface TransportView {
  mode: 'pattern' | 'song';
  patternId: PatternId | null;
  loop: { start: Tick; end: Tick } | null;
}

/** Settings of the current session the engine applies while playing (not part of the document). */
export interface EngineSession {
  /** Metronome clicks while playing. */
  metronome: boolean;
  /** Bars of count-in before recording starts (0 = none). */
  countInBars: number;
}

export interface EngineStats {
  state: EngineState;
  sampleRate: number;
  /** Seconds. */
  baseLatency: number;
  outputLatency: number;
  lookahead: number;
  lateEvents: number;
  /**
   * The longest wait between two scheduler runs since playback started (ms). Late notes only point
   * at a scheduling bug when this stayed well under the lookahead; a busy machine can stall it.
   */
  maxPumpGapMs: number;
  /** Plugin instances that failed to load or threw. */
  faults: number;
}

/** Where plugin definitions come from (the app's registry). */
export interface PluginResolver {
  get(pluginId: string): PluginDef | undefined;
}

/** Supplies encoded bytes for embedded samples (the app's sample store). */
export interface SampleBytesProvider {
  getBytes(ref: SampleRef): Promise<ArrayBuffer | null>;
}

export interface EngineOptions {
  plugins: PluginResolver;
  samples?: SampleBytesProvider;
  /** A plugin asked to change its state (host.updateState): the app turns it into an undoable edit. */
  onPluginStateRequest?(owner: PluginOwner, state: JsonValue): void;
  /** A plugin failed to create or threw; the app shows it. */
  onPluginFault?(owner: PluginOwner, pluginId: string, error: unknown): void;
}

export interface EngineApi {
  readonly sampleRate: number;
  readonly state: EngineState;
  /** Must be called from a user gesture the first time (autoplay policy). */
  resume(): Promise<void>;
  applyDocChange(change: DocChange): void;
  /** Plugin definitions with these ids changed (hot reload, install/uninstall). */
  pluginsChanged(ids: readonly string[]): void;
  setTransportView(view: TransportView): void;
  play(fromTick?: Tick): void;
  stop(): void;
  readonly playing: boolean;
  /** The tick being heard right now (output latency included). */
  playhead(): number;
  /** Loop iteration being heard (pattern mode), for UI step lights. */
  playheadIteration(): number;
  previewNoteOn(channelId: ChannelId, key: number, velocity?: number): number;
  previewNoteOff(channelId: ChannelId, noteId: number): void;
  /** A live MIDI control change (mod wheel = 1, …) for the channel's instrument, value 0–1. */
  previewControl(channelId: ChannelId, cc: number, value: number): void;
  /** Live MIDI pitch bend for the channel, in cents (added to its pitch knob). */
  previewPitchBend(channelId: ChannelId, cents: number): void;
  /** Plays a sample on the preview bus (browser clicks). */
  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void;
  /**
   * A sample's peak overview for drawing, or null while it is still being decoded (the engine's
   * subscribers are notified when it becomes available).
   */
  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null;
  /**
   * Records a microphone stream on the engine's clock: count-in clicks, then `bars` bars (optionally
   * with the project playing along from `fromTick`). Rejects where recording isn't possible.
   */
  record(stream: MediaStream, opts: RecordOptions & { playAlong: boolean; fromTick?: Tick }): Promise<RecordingHandle>;
  /** Decodes and plays an audio file on the preview bus; resolves false if it can't be decoded. */
  previewAudio(bytes: ArrayBuffer): Promise<boolean>;
  stopPreview(): void;
  /**
   * Mixer meters: writes the left and right peak (linear, over the last ~43 ms) of each insert in
   * `order` to out[2i], out[2i + 1]. Allocation-free; call it from the frame loop and do peak hold
   * and decay in the UI. Unknown inserts (and offline engines) read 0.
   */
  readMeters(order: readonly InsertId[], out: Float32Array): void;
  /**
   * The tick (and loop pass) being heard at an AudioContext time as `contextTimeAt` gives it (the
   * mixer's delay compensation is taken into account), extrapolated past what is planned; the stop
   * position while stopped. Recording uses it to place live input where the player heard it.
   */
  tickAt(contextTime: number): { tick: number; iter: number };
  /** The AudioContext time that was being heard at a `performance.now()` timestamp (MIDI events). */
  contextTimeAt(performanceMs: number): number;
  /**
   * For knobs that follow automation: writes the value (spec units) automation gives each target key
   * at the audible time into out[i], NaN where nothing drives it. Allocation-free (frame loop).
   */
  readAutomation(keys: readonly string[], out: Float64Array): void;
  /** A control is being touched (knob drag, MIDI CC stream, recording): automation lets go of it meanwhile. */
  touch(key: string, on: boolean): void;
  /** The tempo being heard (it moves with tempo automation). */
  tempoNow(): number;
  setSession(session: EngineSession): void;
  /** Seconds of latency the mixer adds (plugin delay compensation); the playhead already accounts for it. */
  graphLatency(): number;
  stats(): EngineStats;
  /** Fires on playing/stopped and state changes, and when graphLatency() changes. */
  subscribe(fn: () => void): () => void;
  dispose(): Promise<void>;
}
