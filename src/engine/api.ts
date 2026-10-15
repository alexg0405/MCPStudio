/**
 * The engine's public surface. The UI may import types from here (and only here); it reaches the
 * engine instance through app services.
 */
import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, PatternId, PluginOwner, SampleRef, Tick } from '@core/model/types';
import type { AudioTap, JsonValue, PluginDef } from '@agstudio/sdk';
import type { Waveform } from './waveform';
import type { RecordOptions, Recording, RecordingHandle } from './recorder';
import type { AudioCapture, AudioInput, CapturedAudio } from './audio-input';
import type { SampleCache } from './samples';

export type { Waveform, RecordOptions, Recording, RecordingHandle, AudioCapture, AudioInput, CapturedAudio };

export type EngineState = 'suspended' | 'running' | 'closed' | 'interrupted';

/** A decoded sample's audio (at the engine's sample rate). Read-only: it is the engine's own copy. */
export interface SampleData {
  sampleRate: number;
  channels: readonly Float32Array[];
  /** Seconds. */
  duration: number;
}

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
  /**
   * While playing: how fast the audio clock advanced against the wall clock over the last second
   * (1 = keeping up; 0.9 = a tenth of the sound dropped out because the audio thread couldn't finish
   * in time). Absent until a second has been measured.
   */
  keepUp?: number;
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
  /** Bytes of embedded samples (used when no `sampleCache` is given: the engine then makes its own). */
  samples?: SampleBytesProvider;
  /**
   * The decoded-sample cache to use (with its own bytes provider and memory budget). The app shares
   * one between the realtime engine, offline renders and probes so nothing is decoded twice.
   */
  sampleCache?: SampleCache;
  /** A plugin asked to change its state (host.updateState): the app turns it into an undoable edit. */
  onPluginStateRequest?(owner: PluginOwner, state: JsonValue): void;
  /** A plugin failed to create or threw; the app shows it. */
  onPluginFault?(owner: PluginOwner, pluginId: string, error: unknown): void;
  /**
   * A running plugin instance tapped its audio for its editor (`host.tap()`); `live` false when that
   * instance went away. The app hands editors a stable view of the latest tap per owner.
   */
  onPluginTap?(owner: PluginOwner, tap: AudioTap, live: boolean): void;
}

export interface EngineApi {
  readonly sampleRate: number;
  readonly state: EngineState;
  /** Must be called from a user gesture the first time (autoplay policy). */
  resume(): Promise<void>;
  /** Resolves when the master chain and every plugin instance (instruments and effects) have loaded. */
  ready(): Promise<void>;
  applyDocChange(change: DocChange): void;
  /** Plugin definitions with these ids changed (hot reload, install/uninstall). */
  pluginsChanged(ids: readonly string[]): void;
  setTransportView(view: TransportView): void;
  play(fromTick?: Tick): void;
  stop(): void;
  /**
   * Stops all sound right now: playback, every note (hard), previews, and audio-thread plugins'
   * buffers; the output ducks for a moment so ringing reverb and delay tails stop too.
   */
  panic(): void;
  /**
   * Plays through this output device (`MediaDeviceInfo.deviceId`; '' = the system default).
   * Resolves false where the browser can't choose (no AudioContext.setSinkId) or the device is gone.
   */
  setOutputDevice(deviceId: string): Promise<boolean>;
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
   * A sample's decoded audio for analysis (normalize, slicing at transients, tempo detection);
   * null when it can't be decoded. Don't modify the channels.
   */
  sampleData(ref: Pick<SampleRef, 'source' | 'name'>): Promise<SampleData | null>;
  /**
   * Records a microphone stream on the engine's clock: count-in clicks, then `bars` bars (optionally
   * with the project playing along from `fromTick`). Rejects where recording isn't possible.
   */
  record(stream: MediaStream, opts: RecordOptions & { playAlong: boolean; fromTick?: Tick }): Promise<RecordingHandle>;
  /**
   * Opens a live input (a getUserMedia stream) on the engine's clock: a level meter, monitoring
   * through a mixer track, and captures of any length (audio recording). Realtime engines with
   * cross-origin isolation only; rejects otherwise.
   */
  openAudioInput(stream: MediaStream, opts: { channels: 1 | 2; label?: string; latency?: number }): Promise<AudioInput>;
  /** Short clicks on the monitor bus (never exported), for latency calibration; returns when each plays (context time). */
  playTestClicks(count: number, interval: number): number[];
  /** While on, song mode without a loop region plays on past the song's end instead of looping (audio recording). */
  setSongOpenEnded(on: boolean): void;
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
  /**
   * What goes to the speakers (the master track, previews and clicks) for visualizers: spectrum and
   * waveform, read on the frame loop. Inactive offline and in tests.
   */
  outputTap(): AudioTap;
  /**
   * True while a time-stretched copy of an audio clip channel's sample is being computed (its clips
   * play in time, at the wrong pitch, until then). Subscribers hear when it finishes.
   */
  isStretching(channelId: ChannelId): boolean;
  stats(): EngineStats;
  /** Fires on playing/stopped and state changes, and when graphLatency() changes. */
  subscribe(fn: () => void): () => void;
  dispose(): Promise<void>;
}
