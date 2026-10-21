import type { InsertId, PluginOwner } from '@core/model/types';
import type { AudioTap, JsonValue, OrderedMix, TransportInfo } from '@agstudio/sdk';
import type { PluginResolver } from './api';
import type { NoteFeedHub } from './note-feed';
import type { ParamRegistry } from './param-lane';
import type { SampleCache } from './samples';
import type { SampleResidency } from './sample-residency';
import type { WorkletPortImpl } from './worklet-port';

/** What strips tell the engine's idle parking (engine/idle-parking.ts) when the picture of what can sound may have changed. */
export interface IdleSignals {
  /**
   * Something that was asleep is awake, or the wiring changed: work out now what may stay out of the graph. Calls for the
   * opposite (a plugin fell asleep) are not made: parking waits for the next tick, waking cannot.
   */
  changed(): void;
  /**
   * The wiring changed (a route, a slot, a channel's output, an effect that finished loading): look again, once, after the
   * current task, however many changes there were (a project loads hundreds).
   */
  rewired(): void;
  /** A plugin fell asleep: worth looking at on the next tick (nothing is done at once). */
  slept(): void;
}

/** What channel strips and mixer inserts need from the engine (keeps them decoupled from it). */
export interface EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  /** Which decoded buffers audio clips play from are in memory (and the stretched copies). */
  readonly residency: SampleResidency;
  readonly transportInfo: TransportInfo;
  readonly offline: boolean;
  /** Automatable params by target key (automation, controller links, knobs that follow automation). */
  readonly params: ParamRegistry;
  insertInput(id: InsertId): OrderedMix;
  /**
   * Seconds a channel routed to insert `id` is held back for delay compensation: the song's events for it (notes,
   * clip starts, automation) are scheduled this much later, so the audio needs no delay line and live notes are not
   * delayed (see MixerGraph.shiftSeconds).
   */
  channelShift(id: InsertId): number;
  requestState(owner: PluginOwner, state: JsonValue): void;
  reportFault(owner: PluginOwner, pluginId: string, err: unknown): void;
  /** A plugin instance tapped its audio for its editor (or, live false, the tap went away). */
  reportTap?(owner: PluginOwner, tap: AudioTap, live: boolean): void;
  loadModule(url: string): Promise<void>;
  readonly ports: Set<WorkletPortImpl>;
  /** Absent offline and where idle parking is off. */
  readonly idle?: IdleSignals;
  /** The notes instrument channels play, for effects that follow a melody (`PluginHost.notes`). */
  readonly noteFeed: NoteFeedHub;
  /** Something subscribers show changed (e.g. a time-stretch started or finished). */
  notify?(): void;
}
