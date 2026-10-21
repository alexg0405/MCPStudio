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
import type { LaunchClock, LaunchDriver } from '@core/launcher/run';
import type { LiveFxOutput } from './live-midi-fx';

export type { Waveform, RecordOptions, Recording, RecordingHandle, AudioCapture, AudioInput, CapturedAudio, LiveFxOutput };

/**
 * A live meter on one audio node (see engine/meter): the numbers the audio thread measures, in shared memory (a
 * `readings` slot per value: `R` in engine/meter/layout), for the frame loop to read without any message. Closing it
 * takes the processor off the audio thread.
 */
export interface MeterHandle {
  readonly readings: Float64Array;
  /** Momentary and short-term loudness every 100 ms (a ring: `R.histCount` points were written). */
  readonly history: Float32Array;
  /** Linear power per FFT bin (full detail only). */
  readonly spectrum: Float32Array;
  /** The newest 2048 frames, left and right interleaved (a ring; full detail only). */
  readonly scope: Float32Array;
  readonly sampleRate: number;
  /** The processor runs. */
  readonly active: boolean;
  /** Render quanta handled so far: it stands still once closed. */
  readonly blocks: number;
  /** Full: also bands, spectrum and scope (costs more). */
  setDetail(full: boolean): void;
  /** Restarts the integrated loudness, the loudness range, the maximums and the history. */
  reset(): void;
  close(): void;
}

/** Where the audio context is: not started, running, shut down, or taken over by the system (a call, another app). */
export type EngineState = 'suspended' | 'running' | 'closed' | 'interrupted';

/** A decoded sample's audio (at the engine's sample rate). Read-only: it is the engine's own copy. */
export interface SampleData {
  sampleRate: number;
  channels: readonly Float32Array[];
  /** Seconds. */
  duration: number;
}

/** What the transport plays: a pattern on loop (pattern mode) or the song (song mode), with the loop region it wraps in. */
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

/** Health figures of the running engine, for the diagnostics display. */
export interface EngineStats {
  state: EngineState;
  sampleRate: number;
  /** Seconds. */
  baseLatency: number;
  outputLatency: number;
  lookahead: number;
  /** Seconds between pressing play and the first beat (it follows the audio buffer). */
  startLead?: number;
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
  /** Channels and mixer inserts idle parking has taken out of the audio graph right now (absent where parking is off). */
  parked?: { channels: number; inserts: number };
}

/** Where plugin definitions come from (the app's registry). */
export interface PluginResolver {
  get(pluginId: string): PluginDef | undefined;
}

/** Supplies encoded bytes for embedded samples (the app's sample store). */
export interface SampleBytesProvider {
  getBytes(ref: SampleRef): Promise<ArrayBuffer | null>;
  /** The stored file read lazily (a part at a time), for songs too long to hold in memory whole (the decks). */
  getBlob?(ref: SampleRef): Promise<Blob | null>;
}

/** What an engine is made with: where plugins and sample bytes come from, and how it reports plugin events. */
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
  /**
   * Take plugins that sleep, and the mixer chains only they feed, out of the audio graph until a note comes
   * (engine/idle-parking.ts). Default true; realtime engines only (offline renders never park). A switch for
   * measuring and for finding out whether parking is behind a problem.
   */
  idleParking?: boolean;
}

/**
 * Where live audio (the DJ decks) joins the engine's output: the running AudioContext, a node that feeds the
 * master safety limiter and the chosen output device, and the clock the speakers are on. A rebooted engine has a
 * new host (a new context), so whoever holds one watches `EngineApi.subscribe` and rebuilds.
 */
export interface DeckHost {
  readonly ctx: BaseAudioContext;
  /** Connect to this: it is mixed with the song and its previews, then limited, then heard. */
  readonly output: AudioNode;
  /** Adds an AudioWorklet module to the context (once per URL). */
  loadModule(url: string): Promise<void>;
  /** The context time coming out of the speakers right now (output latency included). */
  heardTime(): number;
}

/** How the browser's audition plays a file (`EngineApi.previewAudio`). */
export interface PreviewOptions {
  /** Playing speed against the recording, pitch following (a sampler's rate: 2 is an octave up and twice as fast). Default 1. */
  rate?: number;
  /** Time-stretch to this length ratio (new length ÷ old) keeping the pitch: a loop at 120 BPM played at 90 is 120 / 90. Default none. */
  stretch?: number;
  /** While the song plays, wait for its next beat before starting (so a loop lands in time). Starts at once when stopped. */
  onBeat?: boolean;
  /** Repeat until stopped. */
  loop?: boolean;
}

/** Everything the app asks of an audio engine: transport, previews, recording, meters and timeline readouts. */
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
  previewAudio(bytes: ArrayBuffer, opts?: PreviewOptions): Promise<boolean>;
  stopPreview(): void;
  /** Level of the audition (the browser's preview): a linear gain, 0 to 2; the engine starts at 0.8. */
  setPreviewVolume(gain: number): void;
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
  /**
   * Opens a meter on the master (`MASTER`) or on an insert's output (after its fader): BS.1770 loudness, true peak,
   * correlation, bands, spectrum. Null where metering is not possible (offline engines, no cross-origin isolation, the
   * engine has not started). `close()` it when nobody watches. A rebooted engine's meters are made again by `EngineHost`.
   */
  openMeter?(source: InsertId, opts?: { full?: boolean }): MeterHandle | null;
  /**
   * The live-audio host of a realtime engine (null offline and in tests): the DJ decks play through it, so the
   * output device choice and the safety limiter apply to them too.
   */
  deckHost?(): DeckHost | null;
  /**
   * The clip launcher (see core/launcher): the engine plays the runs of the driver on top of the song, in time with
   * the transport, and asks it to `advance` on every scheduler tick. Optional: engines without a transport (fakes)
   * leave these out.
   */
  setLauncher?(driver: LaunchDriver | null): void;
  /** Where the transport is on the launcher axis (all zero while nothing plays). */
  launcherClock?(): LaunchClock;
  /** The driver's runs changed: play them (starts the transport for the launcher alone when nothing plays). */
  launcherChanged?(): void;
  /**
   * Hears the notes a channel's MIDI effects play for live keys, as they start and end (note recording can keep these in place of
   * the keys played). Optional: engines that play nothing (fakes) leave it out. Returns its removal.
   */
  onLiveFxOutput?(listener: (output: LiveFxOutput) => void): () => void;
  /** Fires on playing/stopped and state changes, and when graphLatency() changes. */
  subscribe(fn: () => void): () => void;
  dispose(): Promise<void>;
}
