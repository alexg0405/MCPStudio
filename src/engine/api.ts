/**
 * The engine's public surface. The UI may import types from here (and only here); it reaches the
 * engine instance through app services.
 */
import type { DocChange } from '@core/history/history';
import type { ChannelId, InsertId, PatternId, PluginOwner, SampleRef, Tick } from '@core/model/types';
import type { JsonValue, PluginDef } from '@agstudio/sdk';

export type EngineState = 'suspended' | 'running' | 'closed' | 'interrupted';

export interface TransportView {
  mode: 'pattern' | 'song';
  patternId: PatternId | null;
  loop: { start: Tick; end: Tick } | null;
}

export interface EngineStats {
  state: EngineState;
  sampleRate: number;
  /** Seconds. */
  baseLatency: number;
  outputLatency: number;
  lookahead: number;
  lateEvents: number;
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
  /** Plays a sample on the preview bus (browser clicks). */
  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void;
  /** Decodes and plays an audio file on the preview bus; resolves false if it can't be decoded. */
  previewAudio(bytes: ArrayBuffer): Promise<boolean>;
  stopPreview(): void;
  /**
   * Mixer meters: writes the left and right peak (linear, over the last ~43 ms) of each insert in
   * `order` to out[2i], out[2i + 1]. Allocation-free; call it from the frame loop and do peak hold
   * and decay in the UI. Unknown inserts (and offline engines) read 0.
   */
  readMeters(order: readonly InsertId[], out: Float32Array): void;
  stats(): EngineStats;
  /** Fires on playing/stopped and state changes. */
  subscribe(fn: () => void): () => void;
  dispose(): Promise<void>;
}
